---
title: "登录以后，下一次请求怎么认出这个账号？"
date: 2026-11-22 08:30:00
categories:
  - mini-12306
tags:
  - Spring Boot
  - Spring MVC
  - HttpSession
  - Cookie
  - BCrypt
description: "沿着一次 login、携带会话访问 me、logout 和退出后的访问，说明密码验证与服务端会话如何分工，以及 Cookie 为什么只是会话的查找标识。"
---

mini-12306 的注册接口只创建账号，不建立登录状态。要让后续请求知道“现在是谁”，客户端需要先调用登录接口：

```text
POST /api/users/login
Content-Type: application/json

{"username": "mia_train", "password": "Train1234"}
```

验证通过后，响应返回账号的公开资料，同时由服务端建立一个会话。客户端保存响应中的 Cookie，下一次请求自动带上它。会话存在时，`GET /api/users/me` 返回当前账号；调用退出接口后，同一个 Cookie 再访问就得到 401。

这条链路要回答两个不同的问题：登录时怎样确认密码属于这个账号，以及之后的请求凭什么相信客户端仍然代表这个账号。前者靠一次凭据验证，后者靠服务端保存的会话状态。

## 1. 登录接口先验证凭据，再建立会话

登录请求体只有两个字段，都要求非空白：

```java
public record UserLoginRequest(
        @NotBlank String username,
        @NotBlank String password
) {
}
```

Controller 的 login 方法分两步：先把用户名和密码交给 UserLoginService.authenticate，验证成功后才会操作会话：

```java
@PostMapping("/login")
public UserProfileResponse login(
        @Valid @RequestBody UserLoginRequest request,
        HttpServletRequest httpRequest
) {
    UserProfileResponse user = loginService.authenticate(
            request.username(),
            request.password()
    );

    HttpSession oldSession = httpRequest.getSession(false);
    if(oldSession != null) {
        oldSession.invalidate();
    }

    HttpSession session = httpRequest.getSession(true);
    session.setMaxInactiveInterval(30 * 60);
    session.setAttribute(CurrentUserSession.LOGIN_USER_ID, user.id());

    return user;
}
```

`@Valid` 在方法执行前检查两个字段非空；缺字段、空白或请求体无法解析时返回 400，方法体不会执行。通过校验后，authenticate 负责核对密码，Controller 负责会话。两个职责分开：登录服务不接触 HttpSession，即使换一种身份载体，密码验证部分也能独立存在。

登录成功返回 200 和资料正文，不是 201：这里没有创建新的业务资源，账号在注册时已经存在。响应正文与 /me 相同，只含 id、username、createdAt。

## 2. 密码核对：一条响应覆盖两种失败

UserLoginService.authenticate 的实现如下：

```java
public UserProfileResponse authenticate(
        String username,
        String password
) {
    if(password.getBytes(StandardCharsets.UTF_8).length > 72) {
        throw new InvalidCredentialsException();
    }

    UserAccount user = userMapper.findByUsername(username);

    if(user == null ||
            !passwordEncoder.matches(password, user.getPasswordHash())) {
        throw new InvalidCredentialsException();
    }

    return UserProfileResponse.from(user);
}
```

第一项检查是 UTF-8 字节数。注册接口已经拒绝超过 72 字节的密码，登录再检查一次，是因为 BCrypt 只读取前 72 字节：如果不先拦截，一个 73 字节的输入可能与某个 72 字节密码得到相同结果。超长输入在这里按“凭据无效”处理，返回 401，而不是 400——请求格式本身没有错，但它已经超出登录所能可靠核对的长度。登录 DTO 也只要求非空白，没有注册那样的长度规则。

真正的核对由 `passwordEncoder.matches` 完成：它从存储的哈希中取出盐和成本参数，用同一算法重新计算，再比较结果。密码明文不参与比较，也不会出现在响应里。

账号不存在和密码不匹配被合并为同一个条件：`user == null` 时直接短路，不调用 matches；否则用 matches 判断。两种情况都抛出 InvalidCredentialsException，统一异常处理返回 401 和“用户名或密码错误”。调用方无法从正文区分“没有这个用户名”和“密码错了”。

这是在登录接口上减少账号枚举的措施。注册接口的 409 已经会暴露用户名是否被占用，两个接口的取舍不同：注册需要告诉调用方换个名字，登录则不必说明失败在哪一步。

统一的文案不等于所有差异都消失。账号不存在时跳过了 BCrypt 计算，响应时间可能与密码错误不同；项目没有做恒定时间处理，也没有测量过这类时间差。它也不是防爆破：没有失败次数限制、验证码或账号锁定。

## 3. 服务端保存的只是一个用户 ID

验证成功后，Controller 先看请求里有没有旧会话：

```java
HttpSession oldSession = httpRequest.getSession(false);
if(oldSession != null) {
    oldSession.invalidate();
}
```

`getSession(false)` 表示“如果已有会话就返回，没有也不新建”。登录前如果浏览器带着某个会话，它会被作废；随后 `getSession(true)` 再建立一个新会话。这样做的意图是避免把登录前的会话标识直接带入已登录状态——如果这个标识曾被别人知道，登录后它不应该还能用来访问账号。这是会话固定攻击的防御思路。当前测试没有构造“登录前已有会话”的场景，因此新会话是否换发了不同的标识，没有专项断言。

新会话只放一个属性：

```java
session.setMaxInactiveInterval(30 * 60);
session.setAttribute(CurrentUserSession.LOGIN_USER_ID, user.id());
```

值是 Long 类型的用户 ID，不是用户名、密码或密码哈希。会话里保存的越少，资料变化时越不需要同步：资料修改后，下一次 /me 直接从数据库读取最新值，不会读到会话中的旧副本。密码和哈希则完全没有进入会话，即使会话存储泄露，也不会直接带出凭据。

`setMaxInactiveInterval(30 * 60)` 把空闲超时设为 1800 秒。它覆盖容器对该会话的默认值；当前 application.yaml 没有另设全局会话超时。

## 4. 下一次请求：Cookie 只携带会话标识

登录响应通过 Set-Cookie 交给客户端一个 JSESSIONID。这个值是容器生成的随机标识，本身不包含用户 ID 或资料。浏览器保存后，后续同源请求自动带上它；服务端用这个标识找到对应的 HttpSession。

/me 的入口只做一次读取：

```java
@GetMapping("/me")
public UserProfileResponse me(HttpServletRequest httpRequest) {
    return currentUserSession.requireUser(httpRequest);
}
```

读取逻辑集中在 CurrentUserSession：

```java
public UserProfileResponse requireUser(HttpServletRequest request) {
    HttpSession session = request.getSession(false);

    if(session == null) {
        throw new NotLoggedInException();
    }

    Object value = session.getAttribute(LOGIN_USER_ID);

    if(!(value instanceof Long userId)) {
        throw new NotLoggedInException();
    }

    return loginService.getCurrentUser(userId);
}
```

这里有三个检查。没有会话时，`getSession(false)` 返回 null，直接 401；会话存在但属性缺失或类型不是 Long，同样 401。最后 getCurrentUser 按 ID 再查一次数据库，记录不存在也返回 NotLoggedInException。前两个检查确认“这次请求有没有登录标记”，第三个确认标记指向的账号仍然存在。

getCurrentUser 返回的是当场查出的资料：

```java
public UserProfileResponse getCurrentUser(Long userId) {
    UserAccount user = userMapper.findById(userId);

    if(user == null) {
        throw new NotLoggedInException();
    }

    return UserProfileResponse.from(user);
}
```

所以会话不是资料缓存，只是身份线索。每个受保护请求都会经过同一模式：从会话取 ID，再按 ID 查出当前账号。findById 的查询只取 id、username 和两个时间列，不读取 password_hash——读取当前用户时连哈希都不会查出来。乘车人和订单控制器也是这样取得 userId：调用 requireUser，再取返回资料的 id。客户端即使额外提交一个 userId 字段，也不会被采用；归属来自服务端会话，不来自请求参数。

`getSession(false)` 的选择也影响匿名请求：如果写成 `getSession(true)`，每个未登录请求都会新建一个空会话，既浪费内存，也会给匿名访问者发一个没有意义的 Cookie。这里不需要为空会话保留状态。

严格说，Cookie 本身就是一把钥匙：谁拿到这个 JSESSIONID，谁就能在会话有效期内以该账号身份发请求。HttpOnly 能阻止页面脚本直接读取它，但挡不住其他形式的窃取；项目历史的一次真实 HTTP 验证记录了 `Path=/` 和 `HttpOnly=true`，没有验证 Secure、SameSite 或浏览器端的跨站请求防护。

## 5. 30 分钟是空闲超时，不是支付期限

`setMaxInactiveInterval(30 * 60)` 的含义是：会话连续 1800 秒没有被访问就失效。每次请求经过这个会话，容器会更新最后访问时间，时钟重新开始。它不是一个从登录时刻起算的绝对寿命——持续操作可以让会话一直延续。

订单的支付期限看起来也是 30 分钟，但规则完全不同。下单时数据库用 `NOW() + 30 分钟` 生成 `pay_deadline`，它不会因为用户继续浏览而延长；支付条件要求 `pay_deadline > NOW()`，即使关单扫描还没执行，超过期限的订单也不能支付。两者都以秒为单位、都接近半小时，但一个是会话空闲计时，一个是订单的固定截止时间，不能用一个值解释另一个。

同一账号也可以有多个独立会话：在另一台浏览器登录，会建立另一个 HttpSession，彼此不影响。退出只结束当前请求携带的那个会话，不会让该账号的所有登录状态一起失效。项目没有保存“这个账号有哪些会话”的注册表，因此也没有全局退出。

## 6. 退出之后，旧 Cookie 为什么不再有效

退出接口不要求当前一定登录：

```java
@PostMapping("logout")
@ResponseStatus(HttpStatus.NO_CONTENT)
public void logout(HttpServletRequest httpRequest) {
    HttpSession session = httpRequest.getSession(false);

    if(session != null) {
        session.invalidate();
    }
}
```

有会话就作废，没有也返回 204，正文为空。这样重复退出不会报错；它也不会删除账号，只结束当前会话。作废之后，客户端再拿原来的 JSESSIONID 访问 /me，容器找不到有效会话，`getSession(false)` 返回 null，请求得到 401“请先登录”。

一次真实 HTTP 验证走过这条闭环：登录后携带 JSESSIONID 读取 /me，退出后带原 Cookie 再访问 /me 和订单均返回 401。记录产生于 2026-10-25 的代码状态，本次没有重新运行。

{% mermaid %}
sequenceDiagram
    participant C as 客户端
    participant S as 服务端
    C->>S: POST /api/users/login（用户名、密码）
    S-->>C: 200 资料 + Set-Cookie JSESSIONID
    C->>S: GET /api/users/me（Cookie）
    S-->>C: 200 当前账号资料
    C->>S: POST /api/users/logout（Cookie）
    S-->>C: 204，当前会话失效
    C->>S: GET /api/users/me（旧 Cookie）
    S-->>C: 401 请先登录
{% endmermaid %}

## 7. 边界：这套身份机制依赖什么

这套实现用的是 Servlet HttpSession，不是 JWT，也没有接入 Spring Security 的认证过滤器链。身份状态保存在服务端容器的内存中，Cookie 只携带查找它的标识。由此带来的边界需要明确：

- 会话没有共享存储。项目未接入 Spring Session 或 Redis，多实例部署时各进程的会话互不相通；应用重启后的会话延续也没有配置和验证。
- Cookie 是 bearer 凭据。拿到有效 JSESSIONID 的人就能以该账号操作；项目没有 CSRF 防护、登录频率限制或账号锁定，浏览器与部署环境的安全配置也尚未验证。
- 退出只作用于当前会话。没有全局退出、会话列表或强制下线能力。
- 受保护接口在方法内解析会话，但带请求体的接口可能先触发参数校验：未登录且输入无效时，可能先得到 400 而不是 401。不能承诺所有未登录请求都先返回 401。

这些不是登录验证本身的缺陷，而是它没有负责的部分。密码验证回答“这次登录是不是账号本人”，会话回答“后续请求是否延续同一次登录”，两者都不能单独回答“这个请求有没有权限操作某条数据”。后者要在每个业务入口再按账号限定记录，属于下一篇的范围。

## 一次验证，之后靠会话

登录接口只在密码验证通过时建立一个服务端会话，并只保存用户 ID。之后的请求不需要再提交密码：浏览器带上 JSESSIONID，服务端用它找回会话，再按 ID 读取当前账号。退出使这个会话失效，旧标识随之失去意义。

这条链路真正依赖的是服务端的会话记录，而不是客户端声称自己是谁。Cookie 只是找到记录的钥匙，URL 或请求体里的 userId 不参与身份判定。也正因为如此，钥匙一旦泄露，持有者就能在会话有效期内使用它——HttpOnly、CSRF、传输加密和会话共享都属于部署与浏览器边界，当前实现没有补齐，本文也没有把它们写成已经完成。
