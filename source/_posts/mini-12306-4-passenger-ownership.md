---
title: "只传一个乘车人 ID，为什么不能改别人的资料？"
date: 2026-11-22 10:20:00
categories:
  - mini-12306
tags:
  - Spring Boot
  - Spring MVC
  - MyBatis
  - MySQL
description: "让两个账号访问同一条乘车人记录，说明 userId 为什么只能来自会话、越权请求为什么统一表现为 404，以及修改为什么不依赖更新行数判断存在性。"
---

乘车人的详情、修改和删除都以记录 ID 定位。假设账号 A 名下有一条乘车人记录，编号为 7；账号 B 知道了这个编号，用自己的会话发出请求：

```text
GET /api/passengers/7
```

返回 404，正文是“乘车人不存在”。B 用一份格式合法的请求体再尝试修改：

```text
PUT /api/passengers/7
Content-Type: application/json

{"realName": "Changed By Other", "idCard": "00000000000000003X", "phone": "13800000006"}
```

结果同样是 404。A 随后查询自己的记录，资料与之前完全一致。URL 里只出现了记录 ID，服务端凭什么区分这两个账号？

答案不在记录 ID 本身。一次请求同时带着两样东西：路径中的记录编号，以及会话背后的账号。归属条件写进了每条 SQL；只有两者同时匹配，这条记录才对当前请求存在。知道编号不等于有权限，查询认识的是“会话账号 + 记录编号”这一对值。

## 1. 归属参数来自会话，不来自 URL 或请求体

详情接口的入口很短：

```java
@GetMapping("/{id}")
public PassengerResponse findById(
        @PathVariable Long id,
        HttpServletRequest httpRequest
) {
    Long userId = currentUserSession.requireUser(httpRequest).id();
    return PassengerResponse.from(
            passengerService.findById(userId, id)
    );
}
```

`requireUser` 沿用登录篇的读取过程：从会话中取 Long 用户 ID，再确认账号仍然存在；没有有效会话就抛 `NotLoggedInException`，返回 401“请先登录”。通过这一步之后，控制器手里有两个值：来自路径的 `id` 和来自会话的 `userId`。

带请求体的入口还有一个顺序细节：`@Valid` 可能先于方法体执行，未登录且请求体非法时可能先得到 400；401 是身份检查的结果，不保证出现在所有无效输入之前。

只有 `id` 是客户端可以随便填的。`userId` 由服务端从会话推导，方法签名也是把两者分开传入：`findById(userId, id)`。新增、列表、详情、修改和删除五个入口都以同样的方式取得 `userId`，没有任何接口声明一个从请求参数读取的 userId。

请求体也不携带归属。保存乘车人只需要三个字段：

```java
public record PassengerSaveRequest(
        @NotBlank
        @Size(min = 2, max = 50)
        String realName,

        @NotBlank
        @Pattern(regexp = "^[0-9]{17}[0-9Xx]$")
        String idCard,

        @NotBlank
        @Pattern(regexp = "^1[3-9][0-9]{9}$")
        String phone
) {
}
```

即使客户端在 JSON 里额外写一个 `userId`，这个记录类型也没有对应字段，控制器不会读取它，Service 收到的仍是会话推导出的值。归属在参数进入业务层之前就已经确定了。

## 2. 同一条归属规则落在四处

新增时，Service 先把 `userId` 写进实体，再执行插入：

```java
private Passenger fromRequest(
        Long userId,
        PassengerSaveRequest request
) {
    Passenger passenger = new Passenger();
    passenger.setUserId(userId);
    passenger.setRealName(request.realName());
    passenger.setIdCard(request.idCard().toUpperCase(Locale.ROOT));
    passenger.setPhone(request.phone());
    return passenger;
}
```

插入 SQL 的列清单里有 `user_id`，值就是会话中的账号。新记录只能落到当前账号名下，客户端无法在创建时指定另一个所有者。

列表则直接把 `user_id` 放进查询条件，并按记录 ID 排序：

```java
@Select("""
        SELECT id, user_id AS userId, real_name AS realName,
               id_card AS idCard, phone,
               created_at AS createdAt, updated_at AS updatedAt
        FROM passengers
        WHERE user_id = #{userId}
        ORDER BY id
        """)
List<Passenger> findAllByUserId(@Param("userId") Long userId);
```

详情和修改的条件相同，都同时限定记录 ID 与账号：

```java
@Select("""
        SELECT id, user_id AS userId, real_name AS realName,
               id_card AS idCard, phone,
               created_at AS createdAt, updated_at AS updatedAt
        FROM passengers
        WHERE id = #{id}
          AND user_id = #{userId}
        """)
Passenger findByIdAndUserId(
        @Param("id") Long id,
        @Param("userId") Long userId
);

@Update("""
        UPDATE passengers
        SET real_name = #{realName},
            id_card = #{idCard},
            phone = #{phone}
        WHERE id = #{id}
          AND user_id = #{userId}
        """)
int update(Passenger passenger);
```

修改语句里真正决定归属的不是 `SET`，而是 `WHERE`。当 B 提交记录 7 时，`id = 7` 指向 A 的那一行，但 `user_id = B` 不成立，整条 UPDATE 匹配零行，什么也不会写入。服务端并没有先把 A 的记录读出来、再做一个“这不能改”的判断；这条记录从一开始就不在该账号可见的行集合里。

把四种落点放在一起看：

| 操作 | 归属条件 | 记录属于 A、请求来自 B 时 |
| --- | --- | --- |
| 新增 | INSERT 的 `user_id` 取自 B 的会话 | 只能写入 B 名下 |
| 列表 | `WHERE user_id = B` | 结果中没有 A 的记录 |
| 详情 | `WHERE id = 7 AND user_id = B` | 查不到，404 |
| 修改 | `WHERE id = 7 AND user_id = B` | 不命中，查回 404；A 的记录不变 |

这条规则不是由某个统一拦截器自动套上的，而是每个方法自己把 `userId` 传到底。它带来的好处是逻辑直接、SQL 可读；代价是新增入口时必须记得带上这个条件，测试只能覆盖已经写出来的路径，不能保证未来某个遗漏条件的查询会被自动发现。

## 3. 不存在与越权都表现为“查不到”

Service 对查询结果只有一种处理：

```java
public Passenger findById(Long userId, long passengerId) {
    Passenger passenger =
            passengerMapper.findByIdAndUserId(passengerId, userId);
    if(passenger == null) {
        throw new PassengerNotFoundException();
    }
    return passenger;
}
```

Mapper 返回一行或 null。null 有两种来源：编号根本不存在，或者编号存在但属于另一个账号。Service 不区分两者，统一抛 `PassengerNotFoundException`；异常处理再把它映射为 404“乘车人不存在”。

修改也走同一条路。Service 先用请求字段和会话 `userId` 组装实体，补上路径里的记录 ID，执行 UPDATE，然后调用 `findById(userId, passengerId)` 查回：

```java
public Passenger update(
        Long userId,
        Long passengerId,
        PassengerSaveRequest request
) {
    Passenger passenger = fromRequest(userId, request);
    passenger.setId(passengerId);

    try {
        passengerMapper.update(passenger);
    } catch(DuplicateKeyException exception) {
        throw new PassengerAlreadyExistsException();
    }

    return findById(userId, passengerId);
}
```

如果记录属于别人，UPDATE 不命中，随后的归属查询也是 null，最终返回 404。测试在 B 修改失败后，又用 A 的会话读取记录 7，返回的资料与修改前逐字段相同，确认越权请求没有留下任何改动。

为什么统一成 404，而不是“记录存在但你无权访问”的 403？因为 403 本身就泄露了信息：B 可以拿一串编号逐个尝试，用状态码区分哪些编号存在、哪些不存在。两种情况都返回同样的 404 和同样的文案，调用方只能知道“这条记录在当前账号下不可用”，无法确认它在别处是否存在。这是有意选择的披露边界，不是错误处理写得粗糙。

代价是“乘车人不存在”在外人看来并不总是字面事实——记录可能好好地存在，只是不属于这个账号。对当前 API 来说，这两个结果没有业务差别：无论哪种情况，这个账号都不能查看或修改它。

## 4. “更新 0 行”为什么不能直接当作不存在

修改接口还有一种看起来更省事的写法：执行 UPDATE 后检查影响行数，等于 0 就判定记录不存在。这个判断并不可靠。

MySQL 对 UPDATE 可以按“实际改变的行数”计数；在这种口径下，把字段改成与原来完全相同的值，影响行数就是 0。某些客户端或连接参数又会改为报告“匹配到的行数”，同一个操作的数字随之变化。也就是说，0 行至少有两种含义：没有任何行满足条件，或者行满足了条件但值没有变化。把 0 直接翻译成 404，一次内容不变的保存就会被误判为记录不存在。

当前实现完全不看 UPDATE 的返回值。它只用 UPDATE 完成“在 `id + user_id` 匹配时写入”，再用同一条归属查询决定结果：

- 记录不存在或属于别人：UPDATE 不命中，查回 null，404；
- 记录属于当前账号且内容有变化：UPDATE 写入，查回新值，200；
- 记录属于当前账号但内容没变：UPDATE 的计数无论是多少，查回仍能拿到这一行，200。

结果不再依赖驱动报告的是改变行还是匹配行，也不需要在更新前先查一次“它是否存在”。预查询本身也解决不了竞态：检查通过之后、UPDATE 执行之前，记录仍可能被删除；而 UPDATE 的 `WHERE` 已经包含了归属，最终以它是否命中为准更直接。

代价是修改由两条语句组成，而且普通新增和修改都没有引入事务。UPDATE 提交之后、SELECT 执行之前，另一个请求可能已经改了同一行，甚至把它删掉。此时读回的是那一时刻的最新值，或者得到 404；它不保证与本请求刚写入的内容一致。顺序执行的测试能确认“修改后能查到新值”，但不能据此推断并发下也有稳定的快照语义。项目目前接受这个边界，没有为乘车人资料修改增加事务或并发用例。订单保存的是成交快照，不依赖这些资料此后是否再变，那部分留在后面讲。

## 5. 格式、规范化与同账号唯一键

请求 DTO 的三条规则都只检查格式。姓名非空白且 2–50 个字符；身份证是 17 位数字，最后一位是数字或 X/x；手机号是以 1 开头、第二位为 3–9 的 11 位数字。它们不校验出生日期、身份证校验码，也不做实名核验——格式正确不等于证件真实。

身份证在保存前统一转成大写：

```java
passenger.setIdCard(request.idCard().toUpperCase(Locale.ROOT));
```

这样存入的值总是同一种形式，展示和后续比较不必再猜客户端提交的是 `x` 还是 `X`。数据库的排序规则 `utf8mb4_0900_ai_ci` 本身不区分大小写，唯一索引在比较时也不会把两种写法当成两个值；转大写让存储值本身也统一，不依赖比较规则来兜底。

数据库的唯一键是 `(user_id, id_card)`：

```sql
UNIQUE KEY uk_passengers_user_id_card (user_id, id_card)
```

它限定的是“同一账号内不重复”，不是全局唯一。账号 A 和账号 B 可以各自添加同一个证件，形成两条互不关联的记录；修改其中一条，另一条不受影响。现有隔离测试正是这样构造的：B 用 A 记录中的同一证件新建自己的乘车人，创建成功，随后两条记录各自独立。

新增和修改都不先查重，而是让唯一键在写入时给出结果。Service 捕获 `DuplicateKeyException`，转换为 409“该乘车人已添加”：

```java
try {
    passengerMapper.insert(passenger);
} catch(DuplicateKeyException exception) {
    throw new PassengerAlreadyExistsException();
}
```

这与注册时处理用户名重复是同一个思路：预查询只能减少一次明显冲突的写入，不能替代数据库约束；两个并发请求可以同时通过预查询，最终仍要靠唯一键裁决。修改时如果把证件改成同账号另一条记录已使用的值，UPDATE 会触发唯一键冲突，同样返回 409，原记录保持不变。

## 6. 响应对象里为什么没有 userId

内部实体 `Passenger` 有 `userId`，因为 SQL 的归属条件和插入都需要它。返回给调用方的 `PassengerResponse` 没有这个字段：

```java
public record PassengerResponse(
        Long id,
        String realName,
        String idCard,
        String phone,
        LocalDateTime createdAt,
        LocalDateTime updatedAt
) {

    public static PassengerResponse from(Passenger passenger) {
        return new PassengerResponse(
                passenger.getId(),
                passenger.getRealName(),
                passenger.getIdCard(),
                passenger.getPhone(),
                passenger.getCreatedAt(),
                passenger.getUpdatedAt()
        );
    }
}
```

这个字段描述的是记录归属，属于服务端内部信息。调用方已经知道自己在用哪个账号，返回 userId 不会增加信息，反而像一个可以再提交回去的参数；把它留在响应之外，接口就不诱导这种误解。实体与响应类型分开，也让内部字段以后变化时不必自动改变对外 JSON。

需要说明的是，当前响应返回完整的身份证号和手机号，没有做掩码。请求已经要求登录，返回的又是当前账号自己的资料，所以这不构成越权读取；但如果响应被日志、截图或第三方页面原样展示，这些值就会完整暴露。项目目前没有在这里实现脱敏，文章也不把“只返回自己的数据”当成“已经做了展示层保护”。

`createdAt` 和 `updatedAt` 由数据库默认值生成，修改时 `updated_at` 自动更新。它们不参与归属判断，只是资料的时间标记。

## 编号不是权限

这条链路没有单独的权限表，也没有在读出记录后再比较所有者。会话提供账号，路径提供记录编号，每条详情和修改 SQL 都同时限定 `id` 与 `user_id`；不满足条件的行根本不会被选中，所以越权修改不会发生，查不到的行与不属于自己的行得到同样的 404。

同账号唯一键、证件大写规范和响应字段白名单各自处理一个侧面，但它们都不替代 SQL 里的归属条件。真正让“知道编号”不等于“有权操作”的，是每次查询都把当前账号带进条件里。

这条规则也有明确的边界：普通修改没有事务，读回不保证并发快照；证件和手机号只做格式检查；本人响应仍是完整值。下一篇会看到，删除在同样的归属条件之外还要多一道订单引用检查——资料可以删，历史交易关系不能因此断掉。
