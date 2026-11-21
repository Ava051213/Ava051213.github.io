---
title: "一条查询请求怎样走到数据库"
date: 2026-11-22 03:57:05
categories:
  - mini-12306
tags:
  - Spring Boot
  - Spring MVC
  - MyBatis
  - MySQL
description: "以一次车次查询为例，追踪请求参数如何经过绑定、校验和日期范围转换，最终变成 MyBatis 执行的 SQL 和 JSON 响应。"
---

mini-12306 的 `GET /api/trains` 接口按日期、始发站和终到站查询车次。以 2026 年 11 月 1 日的上海虹桥—杭州东为例，请求可以写成下面的形式。

```text
GET /api/trains?departureDate=2026-11-01&fromStation=上海虹桥&toStation=杭州东
```

这三个参数并不会原样组成 SQL。站名用于匹配运行记录的起终点，日期则需要转换为发车时刻的范围。查询完成后，数据库记录还要经过对象映射和响应转换，才能作为 JSON 返回。

## 1. 车号与运行记录

`train_trips` 表保存列车的具体运行记录。假设 G101 于 2026 年 11 月 1 日 08:00 从上海虹桥出发，以杭州东为终点，表中的一行就描述这次运行。同车号在第二天发车时，对应另一条记录，具有不同的 id。

因此，车号不足以确定这次查询的结果。符合条件的记录还必须以上海虹桥为始发站、杭州东为终到站，并且在 11 月 1 日发车。

这个入口的查询范围限于整趟列车的固定起终点。中途站之间的行程由另一个区间查询入口处理：它使用站码和经停记录，并按上车站的发车日期筛选。

## 2. 请求参数的绑定与校验

Spring MVC 根据请求路径和 HTTP 方法，匹配到 TrainTripController.search。类上的 `@RequestMapping("/api/trains")` 声明路径，方法上的 `@GetMapping` 声明请求方式。该方法的实现如下：

```java
@GetMapping
public List<TrainTripResponse> search(
        @Valid @ModelAttribute TrainTripSearchRequest request
) {
    // Return only the public response fields.
    return trainTripService.search(request).stream()
            .map(TrainTripResponse::from)
            .toList();
}
```

方法接收的是 `TrainTripSearchRequest`，URL 中的三个参数由 Spring MVC 绑定到这个对象。`@ModelAttribute` 用于接收查询参数；参数类型和校验规则则定义在 TrainTripSearchRequest 中。

其中，`departureDate` 的类型为 `LocalDate`，`@DateTimeFormat(pattern = "yyyy-MM-dd")` 指定日期的解析格式。请求中的 `2026-11-01` 经解析后成为日期对象，Controller 不需要自行拆分字符串。两个站名仍以字符串保存。

`@Valid` 启用请求对象的校验：日期必须满足 `@NotNull`，两个站名必须满足 `@NotBlank`。缺少出发站、站名为空白，或日期无法解析时，请求返回 400，Controller 方法体不会执行。通过绑定和校验的参数才会传入 `TrainTripService.search`。

## 3. 日期转换为时间范围

`LocalDate` 只表示日期，而数据库的 `departure_at` 保存完整的发车时刻。查询 11 月 1 日，需要包含当天各个时刻发车的记录。将日期补成当天零点并用等号比较，会漏掉 08:00 等其他时刻发车的记录。

TrainTripService.search 先检查起终点，再将日期转换为查询所需的时间边界：

```java
public List<TrainTrip> search(TrainTripSearchRequest request) {
    if(request.fromStation().equals(request.toStation())) {
        throw new InvalidTrainTripSearchException();
    }

    // Build the departure-time range for the requested date.
    LocalDateTime dayStart = request.departureDate().atStartOfDay();
    LocalDateTime nextDayStart = dayStart.plusDays(1);

    return trainTripMapper.findByRouteAndDepartureDay(
            request.fromStation(),
            request.toStation(),
            dayStart,
            nextDayStart
    );
}
```

两个站名都非空，并不代表这组查询条件有效。起终点相同时，Service 抛出业务异常，由统一异常处理返回 400 和“起点和终点不能相同”。

日期转换使用 `atStartOfDay()` 得到当天零点，再通过 `plusDays(1)` 得到次日零点。对于示例请求，查询范围为：

```text
2026-11-01 00:00:00 ≤ 发车时刻 < 2026-11-02 00:00:00
```

这个左闭右开的区间包含当天 00:00 和 08:00，但不包含次日 00:00。后者应归入 11 月 2 日的查询。如果上界也使用“小于等于”，这一时刻发车的记录就会同时出现在相邻两天的结果中。

Service 将这两个时间边界连同站名传给 Mapper。

## 4. SQL 执行与结果映射

TrainTripMapper.findByRouteAndDepartureDay 对应的 SQL 同时按站名和时间范围筛选记录，并按发车时间升序排列结果：

```java
@Select("""
        SELECT id,
               train_number AS trainNumber,
               departure_station AS departureStation,
               arrival_station AS arrivalStation,
               departure_at AS departureAt,
               arrival_at AS arrivalAt
        FROM train_trips
        WHERE departure_station = #{fromStation}
            AND arrival_station = #{toStation}
            AND departure_at >= #{dayStart}
            AND departure_at < #{nextDayStart}
        ORDER BY departure_at
        """)
List<TrainTrip> findByRouteAndDepartureDay(
        @Param("fromStation") String fromStation,
        @Param("toStation") String toStation,
        @Param("dayStart") LocalDateTime dayStart,
        @Param("nextDayStart") LocalDateTime nextDayStart
);
```

该方法定义在 Mapper 接口中，调用由 MyBatis 生成的代理处理。代理执行方法关联的 SQL，再将查询结果映射为 Java 对象，项目不需要为这个接口手写实现类。

`@Param` 把方法参数与 SQL 中的名称对应起来，`#{...}` 引用相应的值。站名和时刻通过参数绑定传入，不会被直接拼接成 SQL 文本。

查询返回的每一行被映射为一个 `TrainTrip` 对象。SQL 中的别名明确了结果列与 Java 属性的对应关系，例如 `train_number AS trainNumber` 对应 `TrainTrip.trainNumber`。这些对象组成 `List<TrainTrip>`，经 Service 返回 Controller。

这条 SQL 直接匹配 `train_trips` 中的站名，不校验车站字典。两个站名不同且不为空白时，即使其中一个不存在，也会进入查询。没有匹配记录时，返回的是空列表，接口仍然响应 200，正文为 `[]`。

## 5. 查询对象与响应对象

Controller 接收到 `List<TrainTrip>` 后，通过 `.map(TrainTripResponse::from)` 将每个元素转换为响应对象，再由 `.toList()` 收集成 `List<TrainTripResponse>`。转换在内存中完成，不会再次查询数据库。

TrainTripResponse.from 将查询对象的六个字段传入响应对象：

```java
// Keep the API response separate from the database entity.
public static TrainTripResponse from(TrainTrip trip) {
    return new TrainTripResponse(
            trip.getId(),
            trip.getTrainNumber(),
            trip.getDepartureStation(),
            trip.getArrivalStation(),
            trip.getDepartureAt(),
            trip.getArrivalAt()
    );
}
```

当前两种对象都包含 id、车号、起终站和到发时刻，字段的值保持不变。直接返回 `TrainTrip` 也能由框架生成 JSON，单独定义响应类型是为了明确接口返回哪些字段。

如果内部对象以后增加了仅供业务处理使用的属性，直接返回它可能使新增属性一并出现在响应中。保留 `TrainTripResponse` 后，接口仍可只返回原来的六个字段，不必随内部对象一起变化。

对象转换结束后，Spring MVC 根据 Controller 上的 `@RestController` 将返回值作为响应体，由 JSON 消息转换器写出 JSON 数组。`from` 方法负责对象之间的转换，消息转换器负责生成最终的响应内容。

## 请求链路中的分工

车次查询的代码集中在 `train` 业务包。Controller、Service 和 Mapper 在同一个应用内通过 Java 方法调用协作，请求与返回的过程如下：

{% mermaid %}
flowchart LR
    Client["客户端"] -->|"查询参数"| Web["Spring MVC<br/>Controller"]
    Web -->|"请求对象"| Service["Service"]
    Service -->|"站名、时间范围"| Mapper["Mapper"]
    Mapper -->|"SELECT"| DB[("MySQL<br/>train_trips")]
    DB -->|"结果行"| Mapper
    Mapper -->|"TrainTrip 列表"| Service
    Service -->|"TrainTrip 列表"| Web
    Web -->|"JSON 数组"| Client
{% endmermaid %}

“按天查询”的规则由 Service 和 SQL 共同表达：前者提供当天和次日的零点，后者使用 `>=` 与 `<` 比较。各层虽然分开处理，但边界约定必须一致，才能使相邻两天的查询互不重叠。

对于示例请求，返回列表中的记录都以上海虹桥为始发站、杭州东为终到站，并在 11 月 1 日发车。空列表表示没有符合条件的记录。这个接口不读取库存，因此无论结果是否为空，都不能据此判断车票是否可售。
