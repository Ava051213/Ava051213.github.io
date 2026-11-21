---
title: "注册一个账号：密码怎样保存，用户名怎样防重"
date: 2026-11-22 06:10:00
categories:
  - mini-12306
tags:
  - Spring Boot
  - Spring MVC
  - MyBatis
  - BCrypt
  - MySQL
description: "从一次注册请求出发，说明参数校验、BCrypt 单向哈希，以及用户名唯一性为什么最终由数据库唯一键裁决。"
---

mini-12306 的注册接口接收一个用户名和密码：

```json
{
  "username": "mia_train",
  "password": "Train1234"
}
```

请求成功时返回 201 和一份公开资料；同一个用户名再次注册，返回 409。这个结果背后是两条不同的规则：密码不能以便于还原的形式落库，用户名不能出现第二条记录。前者靠转换，后者靠约束。注册只创建账号，不建立登录状态；会话要到登录接口才出现。

## 1. 请求先成为校验对象

`POST /api/users/register` 由 UserController.register 处理：

```java
@PostMapping("/register")
@ResponseStatus(HttpStatus.CREATED)
public UserRegisterResponse register(
        @Valid @RequestBody UserRegisterRequest request
) {
    UserAccount user = registrationService.register(
            request.username(),
            request.password()
    );
    return UserRegisterResponse.from(user);
}
```

`@RequestBody` 让 Spring MVC 使用 JSON 消息转换器把请求体绑定为 `UserRegisterRequest`。这是一个 record，字段名与 JSON 属性对应。`@Valid` 让 Bean Validation 在方法执行前检查对象；不通过时，Controller 方法体不会执行，统一异常处理返回 400。通过后，`@ResponseStatus` 把成功状态设为 201。

响应对象由 `UserRegisterResponse.from` 生成，只取 id、username、createdAt。Controller 没有接触密码哈希，也没有创建会话；它只把两个字符串交给 Service，再把返回的账号对象转换为响应。

注册成功返回 201 而不是 200，含义是服务器创建了一个新资源。响应没有 `Location` 头，客户端需要从正文的 id 继续操作。这是当前接口的选择，不影响注册本身的正确性。

## 2. 校验：三层边界

注册请求对象的字段和规则定义在一起：

```java
public record UserRegisterRequest (
    @NotBlank
    @Pattern(regexp = "^[A-Za-z0-9_]{3,50}$")
    String username,

    @NotBlank
    @Size(min = 8, max = 72)
    String password
) {
    @AssertTrue(message = "password must not exceed 72 UTF-8 bytes")
    public boolean isPasswordWithinBcryptLimit() {
        return password == null
                || password.getBytes(StandardCharsets.UTF_8).length <= 72;
    }
}
```

用户名有两条约束。`@NotBlank` 负责拒绝 null、空串和全空白；`@Pattern` 再把范围限定为 3 到 50 个 ASCII 字母、数字或下划线。两条一起用，是因为它们回答不同的问题：前者问“有没有给值”，后者问“值长什么样”。数据库的 `username` 是 `VARCHAR(50)`，与模式上限一致。

密码也有两层。`@Size(min = 8, max = 72)` 约束字符串长度；`isPasswordWithinBcryptLimit` 检查 UTF-8 编码后的字节数。方法里先判断 `password == null` 并直接返回 true，是为了让 null 交给 `@NotBlank` 报错；否则这里会先抛空指针，错误信息就变成了另一个问题。Bean Validation 的大多数约束把 null 视为有效，空值由 `@NotBlank` 统一处理，这个写法与之一致。

字符数与字节数在 ASCII 上相同，在多字节字符上不同。一个汉字在 UTF-8 中通常占 3 字节，25 个汉字是 25 个字符、75 字节：`@Size` 放行，字节检查拒绝。现有测试正是用 `"中".repeat(25)` 构造这个输入，断言返回 400。

72 字节不是随意选的长度。BCrypt 只读取密码的前 72 字节；如果注册时接受更长的输入，两个只有第 73 字节以后不同的密码会在计算时变成同一个。与其静默截断，接口选择拒绝，让限制在创建账号时暴露。登录服务也做同样的字节检查，避免从另一个入口绕过。

当前密码策略只限制最小长度和 BCrypt 上限，没有要求大小写、数字、符号的组合。长度是影响猜测空间的主要因素；复杂度规则如果使用不当，反而会把人推向可预测的替换模式。这是策略取舍，不是密码安全的全部。

校验失败返回 400，正文为 `{"message":"..."}`。当输入长度没有超过 72 个字符、但字节数超过 72 时，例如上面 25 个汉字的情况，提示会映射为“password：UTF-8 编码不能超过 72 字节”，不会显示内部方法名，也不会回显提交的密码。

## 3. BCrypt 把密码变成什么

密码编码器由配置类提供：

```java
@Bean
public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder();
}
```

注册和登录服务注入的是同一个 Bean。注册调用 `encode(password)`，登录调用 `matches(password, storedHash)`。

BCrypt 的结果是一段自包含的字符串：前缀记录算法版本和成本参数，后面编码了盐与计算结果。盐在每次编码时随机生成，并随结果一起保存，所以数据库不需要单独的盐列。同一个密码注册两次，得到的字符串不同；`matches` 从存储值中取出盐，重新计算后比较，不需要还原明文。

盐解决的是预计算问题：攻击者不能为常见密码预先算好一张表，再拿它去匹配所有账号。成本参数解决的是速度问题：BCrypt 被设计得比通用摘要算法慢，提高成本会让每次尝试更贵。SHA-256 这类算法追求快，适合校验文件完整性，不适合直接保存密码——攻击者也能用同样的速度尝试候选密码。

这里的“慢”是对离线猜测而言。正常登录只计算一次，用户感知不到明显延迟；攻击者要尝试大量候选密码，成本才被放大。成本参数的调整也要有依据：太高会拖慢注册和登录，太低则削弱上述效果。当前配置没有显式指定强度，使用编码器的默认值。

`password_hash` 列是 `VARCHAR(100)`。当前 BCrypt 结果约 60 个字符，列宽足够；列宽与明文密码长度无关。

哈希不是加密。加密有密钥，可以解密；哈希没有反向过程，数据库里没有可供取回的原值。密码忘记后，需要另行设计重置流程。登录时也不会把哈希返回给客户端，`matches` 的结果只用于判断是否放行。

## 4. 用户名：预查询为什么不够

参数合法后，Service 按下面的顺序处理：

```java
public UserAccount register(String username, String password) {
    if(userMapper.findByUsername(username) != null) {
        throw new UserAlreadyExistsException(username);
    }

    UserAccount user = new UserAccount(
            username,
            passwordEncoder.encode(password)
    );

    try {
        userMapper.insert(user);
    } catch(DuplicateKeyException exception) {
        throw new UserAlreadyExistsException(username);
    }

    return userMapper.findByUsername(username);
}
```

先按用户名查询，存在就抛出 `UserAlreadyExistsException`；否则编码密码并插入。插入仍可能失败，因此 `insert` 外面单独捕获 `DuplicateKeyException`，转换成同一个业务异常。

用户名检查的第一层查询由 Mapper 提供：

```java
@Select("""
        SELECT id, username, password_hash AS passwordHash,
               created_at AS createdAt, updated_at AS updatedAt
        FROM users
        WHERE username = #{username}
        """)
UserAccount findByUsername(@Param("username") String username);

@Insert("""
        INSERT INTO users (username, password_hash)
        VALUES (#{username}, #{passwordHash})
        """)
@Options(useGeneratedKeys = true, keyProperty = "id")
int insert(UserAccount user);
```

如果预查询找到了记录，Service 抛出 `UserAlreadyExistsException`，接口返回 409，不必尝试写入。

但预查询不能预留用户名。两个请求可以同时查到“用户名不存在”，然后都执行 INSERT。假设 A 和 B 都查不到 `mia_train`：A 先插入并提交；B 随后插入时，唯一索引上已经有这个键值，数据库返回重复键错误。MyBatis-Spring 把这种数据库错误翻译成 `DuplicateKeyException`，Service 捕获后返回 409。真正的裁决在数据库，下面的表定义只保留与用户名唯一性有关的部分：

```sql
CREATE TABLE users (
    ...
    UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;
```

唯一键保证 `users` 中不会出现两条相同用户名的记录。预查询只是提前退出：它让常见的重复注册少一次 INSERT，也让错误更早出现；但它不能预留用户名。若没有唯一键，两个请求会留下两条同名记录。

注册方法没有 `@Transactional`。一次 INSERT 在自动提交下本身就是原子的，不需要额外事务。把“查询 + 插入”包进普通事务也不能消除竞态：在 MySQL 默认的 REPEATABLE READ 下，两个事务的普通 SELECT 都可能读到“不存在”，随后插入仍要在唯一索引上排队。唯一键依然不可省略。

用锁定读（例如 `SELECT ... FOR UPDATE`）看起来能提前占住用户名。这个办法在用户名已存在时确实直观：唯一索引上的等值查询命中记录，InnoDB 锁住这一条索引记录，其他事务无法修改或删除它。问题出在“用户名尚不存在”这个恰恰最需要防重的场景。

InnoDB 的锁加在索引记录上，不是加在“值”这个概念上。查不到 `mia` 时，锁住的是它本该插入的位置：前后两条记录之间的空隙。如果它排在所有记录之后，锁住的是最后一条记录到 supremum 伪记录之间的空隙。这种锁叫间隙锁，作用只有一个——阻止其他事务往这段空隙里插入。

间隙锁之间彼此兼容。两个事务同时 `SELECT ... FOR UPDATE` 同一个不存在的用户名，都能拿到锁，也都能读到“不存在”，谁都不用等；冲突发生在随后的 INSERT，因为插入前要加的插入意向锁与别人持有的间隙锁相斥：

```text
T1: SELECT ... FOR UPDATE WHERE username='mia'   → 空结果，拿到间隙锁
T2: SELECT ... FOR UPDATE WHERE username='mia'   → 空结果，也拿到间隙锁（互不冲突）
T1: INSERT 'mia'   → 插入意向锁要等 T2 的间隙锁
T2: INSERT 'mia'   → 插入意向锁要等 T1 的间隙锁
→ 死锁，InnoDB 检测后回滚其中一个（错误码 1213）
```

被回滚的一方得到死锁错误，另一方插入成功。结果仍然只有一条记录，但路径是死锁加回滚，应用需要识别 1213 并决定是否重试；唯一键路径下，同样的冲突本来就在预期之内，一条重复键错误（1062）就结束了。

这套行为还依赖隔离级别。间隙锁是 REPEATABLE READ 下的机制；在 READ COMMITTED 下，不存在的值基本不会被间隙锁保护，两个事务照样同时通过检查、同时到达 INSERT。也就是说，锁定读的正确性取决于会话隔离级别来自哪里——服务端默认值、JDBC 参数或以后接入的中间件都可能改变它。

锁的范围也是隐患。间隙锁锁住的是“位置”，不是“某个用户名”。假设表里只有 `alice` 和 `zelda`，查 `mia` 会锁住两者之间的整段位置，期间插入 `bob`、`cathy` 的事务同样要被挡住。索引记录越少，空隙越大，早期用户少时这种连带阻塞越明显；被挡住的事务默认要等 `innodb_lock_wait_timeout`（50 秒）才报 1205。

锁定读还必须包在事务里才有意义：如果只加锁定读而不开事务，语句一结束锁就释放，什么也没占住。要让它生效，就得把“查询 + 插入”包进事务，进而引入锁等待、死锁重试和超时参数。为一个可以用唯一键一句话解决的冲突付出这些，并不划算。

所以这里选择让唯一键在插入时给出确定结果：不加锁读，直接 INSERT，冲突时数据库返回 1062，MyBatis-Spring 翻译成 `DuplicateKeyException`，Service 捕获后统一转成 409。没有死锁，不依赖隔离级别，路径最短。需要重申，唯一键不是锁的替代品，而是约束：锁协调“谁先进来”，约束保证“无论谁进来都不能出现第二条记录”。即使某天锁的写法完全正确，绕过 Service 的手工写入或以后新增的入口，仍然要靠唯一键兜底。同类方案里，`INSERT ... ON DUPLICATE KEY UPDATE` 会把冲突变成一次静默更新，语义上不适合注册；`GET_LOCK` 之类的命名锁能在应用层串行化，但多一个失效场景，同样替代不了唯一键。

以上描述的是 InnoDB 的锁定机制；现有用例没有覆盖这条路径。

排序规则也参与判断。`utf8mb4_0900_ai_ci` 中 `ci` 表示大小写不敏感，`ai` 表示重音不敏感。用户名模式限定为 ASCII，所以重音差异当前不会出现；大小写会影响结果：`Mia` 和 `mia` 在该排序规则下相等，唯一键会把它们当成同一个用户名。预查询的 `WHERE username = ?` 使用同一排序规则，两层判断一致；登录查询也使用这个条件，因此登录时用户名同样不区分大小写，显示值保留注册时的写法。用户名没有做 trim 或转小写，模式本身不允许空格，大小写交给数据库比较。

这也意味着 409 会告诉调用方“这个用户名已存在”。固定文案没有回显输入，但没有隐藏账号是否存在。对注册接口来说，这是可用性与账号枚举之间的取舍；要完全隐藏，需要改成邮件或短信确认之类的流程，当前没有实现。

唯一键同时是 `username` 上的索引，预查询可以沿它查找。这里没有为本条查询单独做执行计划分析，不能把“有索引”扩展成对所有数据规模都有同样的执行方式。

{% mermaid %}
flowchart LR
    A["注册请求"] --> B["参数校验"]
    B --> C["按用户名预查询"]
    C -->|"已存在"| D["409 用户名已存在"]
    C -->|"未找到"| E["BCrypt 编码"]
    E --> F["INSERT"]
    F -->|"唯一键冲突"| D
    F -->|"成功"| G["201 公开资料"]
{% endmermaid %}

现有测试对顺序重复注册做了验证：同一份请求体连续提交两次，第二次返回 409，正文为“用户名已存在”。这条用例走到的是预查询分支；两个请求同时通过预查询、由唯一键拦下其一的路径，是根据表结构与异常捕获作出的机制推演，尚无专门的并发注册用例。

## 5. 失败响应：400 与 409 各表示什么

校验失败是 400：请求本身不符合字段规则，调用方修改输入后可以重试。用户名冲突是 409：请求格式没有问题，但与当前资源状态冲突。两个状态码对应不同的处理建议，不能因为都表示失败就合并。

错误正文统一为 `{"message":"..."}`。字段校验的提示由统一异常处理生成，按字段名和错误类型稳定选取一条；密码字节限制的内部属性名会映射回 `password`，不会把 `passwordWithinBcryptLimit` 暴露给调用方。绑定失败或校验失败都不会回显 rejected value。

重复用户名返回固定文案“用户名已存在”。异常对象的消息包含用户名，但处理器没有使用它。固定文案避免把输入原样反射回响应；但 409 本身仍然表明该用户名已被占用，这一点无法靠文案隐藏。

捕获范围是更具体的 `DuplicateKeyException`，不是所有 `DataIntegrityViolationException`。其他数据库错误会继续向上抛出，最终走统一 500，响应只写“服务器内部错误”，不返回 SQL 或堆栈。这样，连接失败、超时之类的错误不会被误报成用户名重复。当前 `users` 只有用户名这一个业务唯一键，所以捕获 `DuplicateKeyException` 足以对应；如果以后增加别的唯一键，这个映射需要重新检查，否则别的冲突也会被报成用户名已存在。

## 6. 插入之后：为什么再查一次

`@Options(useGeneratedKeys = true, keyProperty = "id")` 让自增主键回填到 `UserAccount.id`。但 `created_at` 和 `updated_at` 由数据库默认值生成，INSERT 不会把它们带回 Java 对象。Service 因此再执行一次 `findByUsername`，把完整行读回来。时间以数据库生成的值为准，不在 Java 里重复计算。

返回的响应对象只保留三个字段：

```java
public record UserRegisterResponse(
        Long id,
        String username,
        LocalDateTime createdAt
) {
    public static UserRegisterResponse from(UserAccount user) {
        return new UserRegisterResponse(
                user.getId(),
                user.getUsername(),
                user.getCreatedAt()
        );
    }
}
```

`UserAccount` 上有 `passwordHash`，因为登录验证需要它；`UserRegisterResponse` 没有这个字段，响应就不会带上哈希。

响应形如：

```json
{
  "id": 42,
  "username": "mia_train",
  "createdAt": "2026-11-22T10:15:30"
}
```

测试同时检查了三件事：数据库中的值不等于原始密码、该值与原始密码满足 BCrypt 匹配、响应正文中不出现这个哈希。它没有比较两次注册的哈希是否不同，也没有断言哈希的具体格式。

`UserRegisterResponse` 的作用与第一篇的 `TrainTripResponse` 相同：明确公开字段，避免内部对象以后新增属性时自动出现在 JSON 里。这里还多了一层隐私意义：实体必须携带哈希供登录验证，响应不能跟着携带。

## 7. 这些结论验证到了哪里

现有四个注册测试都通过 MockMvc 调用接口，底层连接测试数据库，不经过独立服务器和真实网络。它们覆盖：正常注册并检查哈希、顺序重复注册返回 409、非法输入返回 400、25 个汉字超过字节上限返回 400。

没有专项覆盖的路径包括：两个请求同时通过预查询、由唯一键拦下其一的并发分支；恰好 72 与 73 字节的边界；大小写不同的重复用户名；用户名长度 3/50 的边界；以及真实 HTTP 下的响应头与 Cookie 行为（注册本身不创建会话）。

文中请求和响应示例是说明性例子，不是一次实际运行的记录。结论来自源码、表结构和测试断言；固定并发用例、真实 HTTP 和压力测试属于不同的证据层级，不能互相替代。

## 8. 边界：注册只解决了什么

这套实现解决的是“密码不以明文落库”和“用户名不重复写入”。它没有验证邮箱或手机号的真实性，没有验证码、频率限制或账号锁定，也没有密码重置、多因素认证和账号注销。公开的注册入口因此可以被脚本批量调用，用户名也可能被提前占用。

这些不是本文要补上的功能，而是理解当前结果的边界：409 能阻止重复，但不能证明注册者是真人；BCrypt 能提高离线猜测成本，但不能阻止弱密码；唯一键能裁决并发写入，但不负责账号生命周期。

注册也不会创建登录状态。201 返回后，客户端仍要调用登录接口，由登录服务验证哈希并建立会话。注册和身份识别是两段独立的流程，本文只走完了前一段。

## 两道防线

注册过程处理了两个不同的风险。密码的风险是“保存了就能被读出来”，因此进入数据库前先做单向哈希，登录时只比较、不还原；用户名的风险是“同一条记录被写两次”，因此数据库保留唯一键，插入冲突成为最终依据。

预查询缩短了常见冲突的路径，但没有取代唯一键。单次重复注册和并发重复注册最终得到同一个 409，原因不是某一次查询恰好及时，而是写入必须经过数据库的约束。密码的防线在 Service 的编码，用户名的防线在数据库的唯一键，两者都不依赖客户端自觉遵守。
