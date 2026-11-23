---
title: "乘车人为什么不能直接删除？"
date: 2026-11-23 16:30:00
categories:
  - mini-12306
tags:
  - Spring Boot
  - Spring MVC
  - MyBatis
  - MySQL
description: "同一个账号删除两条自己的乘车人，为什么一条 204、一条 409？说明归属检查为什么排在引用检查之前、计数为什么不看订单状态，以及并发窗口里外键如何兜底。"
---

账号 A 名下有两个乘车人。编号 7 从没用来买过票，编号 8 出现在一张待支付订单里。A 用自己的会话依次删除：

```text
DELETE /api/passengers/7   → 204
DELETE /api/passengers/8   → 409
```

第二条返回“该乘车人已被订单引用，无法删除”。两条记录的主人是同一个账号，请求也来自同一个人。结果不同，原因不在权限，而在记录有没有进入过订单。

删除这个接口因此同时在处理两件事：清理一份资料，以及判断这份资料是否已经成为某笔交易的一部分。

## 1. 先确认记录属于当前账号

删除入口从会话取账号，路径只提供记录编号：

```java
@DeleteMapping("/{id}")
@ResponseStatus(HttpStatus.NO_CONTENT)
public void delete(
        @PathVariable Long id,
        HttpServletRequest httpRequest
) {
    Long userId = currentUserSession.requireUser(httpRequest).id();
    passengerService.delete(userId, id);
}
```

Service 接到两个值后，先按归属把记录查出来：

```java
@Transactional
public void delete(Long userId, Long passengerId) {
    // Check ownership first so foreign records look exactly like missing ones.
    findById(userId, passengerId);

    // Orders keep their own snapshot, but still reference this row.
    if(passengerMapper.countOrdersByPassengerId(passengerId) > 0) {
        throw new PassengerInUseException();
    }

    try {
        // The owner condition makes foreign rows impossible to delete.
        if(passengerMapper.deleteByIdAndUserId(passengerId, userId) != 1) {
            throw new PassengerNotFoundException();
        }
    } catch(DataIntegrityViolationException exception) {
        // A concurrent order may appear after the check; the foreign key blocks it.
        throw new PassengerInUseException();
    }
}
```

`findById` 使用 `WHERE id = ? AND user_id = ?`。记录不存在、属于别的账号，或者刚被删过一次，都会在这里得到 404“乘车人不存在”。订单检查排在它后面。

顺序不能换。假设先查订单引用：B 拿别人的编号逐个尝试，有订单的返回 409，没订单的返回 404。状态码的差别足以让 B 判断哪些编号存在。先按归属统一返回 404 后，B 只能知道这些编号在自己名下不可用，无法确认它们在别处是否存在。

路径参数不是数字时，请求在进入方法前就转换失败，返回 400；数字但查不到，才是业务层的 404。两者不在同一层处理。

## 2. “被订单引用”是一条历史记录

订单检查只有一句计数：

```java
@Select("""
        SELECT COUNT(*)
        FROM ticket_orders
        WHERE passenger_id = #{passengerId}
        """)
long countOrdersByPassengerId(@Param("passengerId") Long passengerId);
```

它没有状态条件，没有时间范围，也不区分购买模式。只要 `ticket_orders` 里还有一行指向这个乘车人，计数就大于零。已支付、待支付、已取消、已超时的订单都算；旧的数量订单、计价订单、座位订单，以及多人订单的每条明细，也都是 `ticket_orders` 行，都带着 `passenger_id`。

某个乘车人只要下过一单，这条资料就不能再通过这个接口删除，哪怕那笔订单后来取消了。取消、支付、超时改变的是订单状态，订单行仍留在 `ticket_orders` 里，`passenger_id` 仍指向这个乘车人。引用计数不看状态，结果还是 409。

当前项目没有删除订单的接口，业务代码里也没有删除订单的 SQL，订单不会从表里物理消失。如果以后新增了物理删除订单的路径，这条引用关系会跟着改变，需要重新定义规则；现在的删除接口不对这种情况负责。

为什么不只统计待支付和已支付？因为那样会让业务检查和数据库约束给出不同答案。一条已取消的订单仍在表里，`passenger_id` 仍指向这个乘车人，DELETE 到数据库时依然会被外键拒绝。业务检查说“可以删”，数据库说“不行”，最后还是要落到同一个冲突上，只是报错更晚。计数不加状态，是为了和外键实际覆盖的范围保持一致。

订单下单时已经保存了姓名和证件快照，为什么还要保留乘车人这一行？快照决定订单上显示什么，外键决定订单关系指向谁。`ticket_orders.passenger_id` 始终指向 `passengers.id`。删掉父行，只能让引用悬空、级联删除订单，或者把外键置空。第一种破坏历史，后两种改变“订单一定对应某个乘车人”的模型。当前实现没有选其中任何一种，而是拒绝删除。

订单中与乘车人有关的字段可以分成三块：

| 字段 | 作用 |
| --- | --- |
| `passenger_id` | 外键，指向 `passengers.id`，历史关系靠它定位 |
| `passenger_name`、`passenger_id_card` | 下单时的展示快照，不随资料修改而变 |
| `status` | 订单状态，不参与删除引用计数 |

## 3. 真正删除时仍然带着归属条件

业务检查通过后，DELETE 语句自己也限定 `id` 和 `user_id`：

```java
@Delete("""
        DELETE FROM passengers
        WHERE id = #{id}
          AND user_id = #{userId}
        """)
int deleteByIdAndUserId(
        @Param("id") Long id,
        @Param("userId") Long userId
);
```

影响行数不等于 1，Service 抛出 `PassengerNotFoundException`。前面已经查过归属，这里再带一次条件，是因为 `findById` 负责响应语义——先区分 404 和 409；DELETE 才是真正改数据的语句，不能靠“前面查过了”来保证安全。记录在两条语句之间被另一个会话删掉时，DELETE 同样影响 0 行，返回 404 也符合事实。

DELETE 的影响行数没有 UPDATE 那种歧义。UPDATE 把字段改成相同的值，影响行数可能是 0，也可能不是，取决于驱动按“改变行”还是“匹配行”计数。DELETE 删到就是一行，没删到就是没有，可以直接用行数判断结果。

删除成功返回 204，正文为空。现有用例在删除后查了详情、列表和 `passengers` 表：详情 404，列表只剩另一条记录，目标行在表里也确实不存在。行是物理删除的，不是被某个查询条件藏起来。

## 4. 检查通过之后，仍可能冒出一笔订单

`@Transactional` 把归属检查、订单计数和 DELETE 放进同一个事务。事务能保证这几步一起成功或一起失败，但不会锁住这条乘车人。

订单计数是普通 SELECT。MySQL 默认的可重复读下，它读取事务内第一次查询建立的快照，不加锁。另一个事务可以在计数返回 0 之后、DELETE 执行之前，为这个乘车人提交一笔新订单。

```text
时刻   删除事务 T1                          下单事务 T2
t1     findById：记录存在
t2     count：0
t3                                          INSERT ticket_orders(passenger_id = 9)
t4                                          COMMIT
t5     DELETE passengers WHERE id = 9 ...
t6     外键检查发现子记录，错误 1451
```

快照在 t1 的 `findById` 就建立了，t2 的计数沿用它。所以计数看不到 t3 才插入、t4 才提交的订单；即使把计数挪到 t4 之后，只要还在同一个事务里，读到的仍是 t1 时的数据。0 在当时是准确的，只是它描述的是快照，不是 t5 那一刻的表。

DELETE 则是当前读。它要找到并锁住目标行，读的是最新已提交的数据，不看 T1 的快照。InnoDB 在删除父行时会检查 `ticket_orders` 里有没有 `passenger_id = 9` 的子记录，这个检查同样面对当前数据。t4 提交的订单已经在表里，检查命中，语句以错误 1451 结束，父行没有被删掉。

时间线也可以反过来：t5 执行时 T2 已经插入但还没提交，T1 的外键检查会等 T2 的锁。T2 提交，T1 得到同样的 1451；T2 回滚，子记录消失，删除继续。两种顺序都不会留下“父行没了、子记录还在”的状态，区别只在 T1 是立刻失败还是先等一会儿。

MySQL 返回错误 1451，Connector/J 抛出完整性约束异常，Spring 再翻译成 `DataIntegrityViolationException`。Service 的 catch 只包住 DELETE，把这个完整性异常换成 `PassengerInUseException`，全局异常处理再返回 409“该乘车人已被订单引用，无法删除”。

这里的预检查并不承担最终裁决。计数在正常路径上提前给出可读的 409，不必等数据库报错；并发窗口里的删除由外键挡住。即使去掉计数，结果仍然是 409，只是每次都要走一遍异常路径。预检查让常见情况更直接，外键让所有情况都有答案。

如果 DELETE 先提交，并发下单的 INSERT 在检查外键时找不到父行，会失败并回滚。不会出现“乘车人已经删掉，订单却建成了”的状态。

让检查和下单插入排在同一把锁上，也能提前排除这个窗口；代价是删除期间该乘车人的下单会被阻塞，还会多出等待和死锁的可能。当前实现接受窗口存在，把最终裁决交给数据库。

事务由 Spring 代理生效：控制器拿到的是代理对象，方法进入时开启事务，正常返回后提交，异常抛出后回滚。这里抛出的是业务异常，回滚照样发生；DELETE 已经被数据库拒绝，没有留下需要撤销的半成品。

现有用例没有构造“删除与下单同时发生”的场景，这条 catch 分支没有专项运行证据；上面的过程来自外键约束和异常映射的机制推演。能确认的是：预先存在订单时，计数会先返回 409，DELETE 不会执行。另外，catch 只覆盖完整性异常，如果并发以死锁或锁等待超时结束，会走另一条异常路径，不会自动变成 409。

## 5. 被拒绝之后，订单和资料都保持原样

引用检查的用例先用真实下单流程创建一笔订单，再尝试删除乘车人。删除被拒绝后，订单详情仍返回 200，`passengerId` 还是那条记录，`passengerName` 是下单时保存的快照，状态仍是 `PENDING_PAYMENT`。乘车人记录逐字段不变，库存也停在下单后的数量。

拒绝没有留下半成品。订单显示姓名和证件时可以依赖自己的快照，不必再读乘车人表；但它的 `passenger_id` 仍指向那条记录。快照让历史订单不随资料修改而变，外键让这条历史关系始终有落点。

当前没有软删除，也没有级联删除。删除成功就是物理删除，有引用就拒绝。账号注销、订单删除和数据清理都不在这个接口的范围内，它们需要各自的关系规则，不能靠给 `passengers` 加一个 `deleted` 标记顺带解决。

## 资料可以删除，历史关系不能断

删除乘车人时，归属回答“这条记录是不是你的”，引用回答“它能不能消失”。前者让越权和不存在都停在 404，后者让有历史订单的记录停在 409。正常路径上，业务检查给出可读的结果；并发和遗漏时，外键保证不会留下断掉的引用。

资料可以删除，但一旦进入过订单，它就不再只是资料。下一篇从一笔数量订单开始，看扣库存和写订单为什么必须一起成功。
