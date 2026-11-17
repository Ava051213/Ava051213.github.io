---
title: "取消订单失败时，那张票去哪了？"
date: 2026-11-17 07:05:20
categories:
  - mini-12306
tags:
  - Spring Boot
  - MyBatis
  - MySQL
  - 事务
  - 集成测试
description: "通过故障注入模拟取消订单时的异常，验证订单状态更新与库存恢复是否处于同一个 Spring 事务，以及异常后的数据库回滚结果。"
---

取消订单，需要完成两件事：将订单状态改为 `CANCELLED`，再释放这笔订单占用的库存。

对于数量库存订单，释放意味着把库存数量加回去；对于座位订单，则需要将订单占用的座位段恢复为可用状态。

这两步必须在同一个事务里完成。

如果没有事务保护，一旦订单状态更新已经提交，而库存恢复没有成功，数据库就可能留下不一致的状态：订单已经取消，但库存仍然少了一张。

这张票既不能坐，也不能再卖，相当于凭空消失了。

更麻烦的是，这种偏差往往没有人发现。订单看起来正常，库存却已经偏了一张。

那么，怎么证明这两步真的受到同一个事务的保护？

光看 `@Transactional` 注解不够，必须人为制造一次失败：让订单状态修改成功，让库存也确实加回去，然后在最后一步抛出异常，观察数据库会发生什么。

## 一、先让两步操作都成功，再制造异常

首先准备两张票，创建一笔订单：

```java
Long tripId = createTrip();
createInventory(tripId, 2, 2); // 总库存 2，初始余票 2

OrderCreateResponse order = createOrder(
        session, tripId, passenger.id()
);

assertInventoryAndOrderCount(tripId, 1, 1);
```

此时库存剩余 1 张，数据库中有 1 笔订单。

正常取消后，预期应该是：

- 订单状态从 `PENDING_PAYMENT` 变成 `CANCELLED`。
- 剩余库存从 1 恢复到 2。

这里需要区分两种情况。

第一种，库存恢复已经执行成功，但随后发生异常。没有事务时，前面的数据库写入可能已经提交，用户收到的却是失败响应。刷新订单，发现订单已经取消，库存也已经恢复。

第二种，在没有事务保护的情况下，进程恰好在修改订单状态之后、恢复库存之前崩溃。由于订单状态更新已经独立提交，库存恢复却还没有执行，数据库就会留下不一致的状态。在补偿或人工修复之前，系统会持续少卖一张票。

这次测试模拟的是第一种情况：两次写入都执行完成之后，再人为抛出异常。它不能模拟进程在两次写入之间崩溃的情况。

因此，这次测试的关键不是简单地让库存恢复方法报错，而是**必须先让库存恢复操作真正执行成功，再抛出异常。**

## 二、为什么 `doCallRealMethod()` 行不通？

取消时的库存释放按购买模式分流：座位订单释放的是段占用，全程数量订单才执行这条库存恢复 SQL。这个测试用的是旧入口 `POST /api/orders` 创建的全程订单，下面看的是数量库存的恢复。

项目中的 `TicketInventoryMapper` 是一个 MyBatis Mapper：

```java
@Update("""
        UPDATE ticket_inventory
        SET remaining_tickets = remaining_tickets + 1
        WHERE train_trip_id = #{trainTripId}
          AND remaining_tickets < total_tickets
        """)
int restoreOneIfNotFull(
        @Param("trainTripId") Long trainTripId
);
```

注意，这个方法只有声明，没有方法体。

应用启动时，MyBatis 会读取 Mapper 接口上的注解，将 SQL 注册为一条映射语句。其语句 ID 由接口全限定名和方法名组成：

```
接口全限定名.restoreOneIfNotFull
```

随后，MyBatis 通过动态代理生成 Mapper 对象。调用 `restoreOneIfNotFull()` 时，代理并不是在执行某个 Java 方法体，而是在找到对应的 SQL 映射语句后，通过 `SqlSession` 执行数据库操作。

这也解释了为什么测试中使用 `doCallRealMethod()` 会直接抛出 `MockitoException`。

它想调用的真实 Java 方法体根本不存在。

## 三、绕过 Mapper 方法，直接执行真实 SQL

既然不能调用真实方法，那就直接执行 MyBatis 已经注册的 SQL。

测试中可以通过 `SqlSessionTemplate` 完成：

```java
String statementId =
        TicketInventoryMapper.class.getName()
        + ".restoreOneIfNotFull";

int restoredRows = sqlSessionTemplate.update(
        statementId,
        Map.of("trainTripId", tripId)
);

assertEquals(1, restoredRows);
```

这里的语句 ID 和参数名都与 Mapper 中的定义一致，因此执行的就是原来的库存恢复 SQL。

还有一个重要细节：**为什么这条 SQL 会参与 Service 开启的事务？**

本项目中，`SqlSessionTemplate` 和 Mapper 使用同一个 `SqlSessionFactory`，其底层数据源也与 Spring 事务管理器使用的数据源一致。

因此，`SqlSessionTemplate` 执行 SQL 时，会获取当前 Spring 事务关联的 `SqlSession`，而不是另外创建一个独立的事务连接。

所以，这条 SQL 虽然不是通过 Mapper 方法调用的，仍然参与当前 Service 的事务。

## 四、在库存恢复之后抛出异常

现在可以把真实 SQL 放进 Mockito 的 `doAnswer()` 中。

`doAnswer()` 会在被监视的 Mapper 方法被调用时执行自定义逻辑。

```java
doAnswer(invocation -> {
    // The service transaction must be active.
    assertTrue(
        TransactionSynchronizationManager
            .isActualTransactionActive()
    );

    String currentStatus = jdbcTemplate.queryForObject(
            "SELECT status FROM ticket_orders WHERE id = ?",
            String.class,
            order.id()
    );

    // The order status has already been updated.
    assertEquals("CANCELLED", currentStatus);

    // Execute the real inventory restoration SQL.
    int restoredRows = sqlSessionTemplate.update(
            TicketInventoryMapper.class.getName()
                    + ".restoreOneIfNotFull",
            Map.of("trainTripId", tripId)
    );

    assertEquals(1, restoredRows);
    assertInventoryAndOrderCount(tripId, 2, 1);

    // Simulate a failure after both database updates.
    throw simulatedFailure;

}).when(ticketInventoryMapper).restoreOneIfNotFull(tripId);
```

这段测试逻辑实际上完成了三个动作：

1. 确认 Service 开启的事务正在运行。
2. 查询数据库，确认订单状态已经变成 `CANCELLED`——同一事务的连接能看到未提交的更新。
3. 真正执行库存恢复 SQL，确认影响了一行、事务内的余票已经变成 2，然后抛出异常。

这里的异常是测试代码主动构造的，并不是真的让数据库发生了约束冲突；选这个类型，只是为了在库存恢复成功之后模拟一个运行时异常，验证 Spring 的默认回滚行为。它属于运行时异常，默认回滚规则会对这类异常执行回滚。

此时，订单状态更新和库存恢复都已经执行，但事务尚未提交。

异常从 Service 方法中抛出，事务随之结束并回滚。

## 五、事务外检查：数据库是否真的恢复了原样？

测试不能只检查异常有没有抛出，还必须检查事务结束后的数据库状态。

取消之前，先保存订单整行数据：

```java
Map<String, Object> before =
        jdbcTemplate.queryForMap(
            "SELECT * FROM ticket_orders WHERE id = ?",
            order.id()
        );
```

这里没有走 HTTP 入口，而是直接调用注入的 Service 代理 `ticketOrderService.cancel(userId, order.id())`，断言异常从 `@Transactional` 边界原样抛出。随后在事务外检查：

```java
assertEquals(
        before,
        jdbcTemplate.queryForMap(
                "SELECT * FROM ticket_orders WHERE id = ?",
                order.id()
        )
);

assertInventoryAndOrderCount(tripId, 1, 1);
```

这里有两个关键断言：

- 整行订单数据与取消之前完全一致。
- 剩余库存为 1、订单数量为 1。

直接比较整行数据，而不是只检查 `status`，可以避免其他字段被意外修改却没有被发现——状态仍是 `PENDING_PAYMENT` 也由这次比对一起证明。

回滚之后，测试还会用 MockMvc 查一遍订单详情和余票：订单仍是 `PENDING_PAYMENT`，余票仍是 1。这是接口层的验证，不是真实 HTTP 请求——MockMvc 不经过网络。

### 为什么测试方法不能加 `@Transactional`？

这一点也很重要。

如果测试方法本身带有 `@Transactional`，测试框架会在最外层先开一个事务，Service 会加入它。这样 `isActualTransactionActive()` 从一开始就是 `true`，和 Service 有没有开事务无关。

更麻烦的是，所有写操作都留在这个外层事务里，最后由测试统一回滚。于是“数据回到了原样”可能只是测试自己的功劳，和 Service 的事务没关系。

因此，这个测试方法不应该添加 `@Transactional`。

还可以在三个位置检查事务状态：

```java
// Before invoking the service.
assertFalse(
    TransactionSynchronizationManager.isActualTransactionActive()
);

// Inside the mocked mapper callback.
assertTrue(
    TransactionSynchronizationManager.isActualTransactionActive()
);

// After the service call has failed.
assertFalse(
    TransactionSynchronizationManager.isActualTransactionActive()
);
```

三个结果分别是 `false`、`true`、`false`。

这能帮助确认事务确实是在 Service 调用过程中开启，并且在异常退出后结束，而不是由测试方法提供的外层事务造成的。

## 六、这次测试真正验证了什么？

这次测试验证的不是简单的异常处理，而是一个完整的事务回滚场景：

- 订单状态更新确实执行了。
- 库存恢复 SQL 确实执行了。
- 两次数据库写入都发生在同一个 Spring 事务中。
- 库存恢复之后发生运行时异常。
- 事务结束后，订单和库存都恢复到了操作之前的状态。

所以，那张票并没有丢。

虽然取消过程中订单状态和库存都曾经被修改，但由于事务最终回滚，数据库对外呈现的仍然是取消之前的状态。

这里有两个值得记住的细节：

**第一，MyBatis Mapper 是接口代理，不一定存在可以调用的 Java 方法体。** 对于这种场景，可以通过 `SqlSessionTemplate` 和映射语句 ID 执行真实 SQL。

**第二，验证事务回滚，不能只看异常是否抛出。** 真正重要的是事务结束之后，数据库中的数据是否恢复到了原来的状态。

这也是为什么真实数据库集成测试很有价值：它验证的是数据库最终发生了什么，而不只是代码走过了哪些分支。

下一篇从一条看起来多余的唯一键说起：车厢表上已经有 `(train_trip_id, carriage_number)` 了，为什么还要一个 `(train_trip_id, id)`。

---

源码（提交 `33864267f1695f7e210bb68f8150c155ff9ef365`）：

- [TicketOrderService.java](https://github.com/Ava051213/mini-12306/blob/33864267f1695f7e210bb68f8150c155ff9ef365/src/main/java/com/mia/mini12306/order/TicketOrderService.java)
- [TicketOrderMapper.java](https://github.com/Ava051213/mini-12306/blob/33864267f1695f7e210bb68f8150c155ff9ef365/src/main/java/com/mia/mini12306/order/mapper/TicketOrderMapper.java)
- [TicketInventoryMapper.java](https://github.com/Ava051213/mini-12306/blob/33864267f1695f7e210bb68f8150c155ff9ef365/src/main/java/com/mia/mini12306/inventory/mapper/TicketInventoryMapper.java)
- [TicketOrderIntegrationTests.java](https://github.com/Ava051213/mini-12306/blob/33864267f1695f7e210bb68f8150c155ff9ef365/src/test/java/com/mia/mini12306/order/TicketOrderIntegrationTests.java)
