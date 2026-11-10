---
title: 区间：给一张票建立坐标系
date: 2026-11-10 21:30:00
categories: [项目复盘, mini-12306]
tags: [MySQL, Spring Boot, 系统设计]
description: mini-12306 系列第一篇。买票之前系统要回答两个问题：有没有、多少钱。这两个问题都建立在同一套坐标系上——站点、站序、区间。
---

这是 mini-12306 系列的第一篇。整个系列只回答一个问题：**一张票，在系统里到底占用了什么？** 坐标怎么定义、价格从哪来、怎么防止重复占用、怎么按时归还、怎么证明这一切——一篇回答一个子问题。

第一篇不从订单开始，从买票之前开始。点下「查询」那一刻，系统要回答两个问题：这个方向、这一天有没有车；有的话，多少钱。这两个问题背后是同一套坐标系：站点、站序、区间。后面每一篇的“有没有票”，都要先翻译成站序上的区间才问得出来。

> 版本锚点：代码截至 mini-12306 仓库 `3386426`；本篇涉及迁移 V5（站点与经停表）、V6（区间票价表）；相关集成测试 33 个（TrainTripIntegrationTests 4 个、TicketQueryIntegrationTests 9 个、TicketPriceIntegrationTests 9 个、StationQueryIntegrationTests 11 个）。演示数据来自仓库里的 `seat_sales_demo.sql`，站点编码带 D 前缀，价格为演示值。

## 一、现场

D9001，2026-11-10：上海虹桥 08:00 出发，08:45 到苏州北，停 5 分钟，09:30 到无锡东，停 5 分钟，10:30 到南京南。四站，三段行车区间。

用户发起的查询长这样：

```http
GET /api/ticket-service/ticket/query?departureDate=2026-11-10&fromStation=DSHH&toStation=DWXD
```

数据库里与这次查询有关的数据有三组。站点字典 4 行：

| code | name | 含义 |
|---|---|---|
| DSHH | 上海虹桥 | 始发站 |
| DSZB | 苏州北 | 经停 |
| DWXD | 无锡东 | 经停 |
| DNJN | 南京南 | 终到站 |

经停表 4 行，给出每一站的坐标和时间：

| stop_sequence | station | arrival_at | departure_at |
|---|---|---|---|
| 1 | 上海虹桥 | — | 08:00 |
| 2 | 苏州北 | 08:45 | 08:50 |
| 3 | 无锡东 | 09:30 | 09:35 |
| 4 | 南京南 | 10:30 | — |

区间票价表 8 行，二等座 6 行、一等座 2 行：

| departure_sequence | arrival_sequence | seat_type | price_cents |
|---|---|---|---|
| 1 | 2 | 2 | 5000 |
| 2 | 3 | 2 | 4000 |
| 3 | 4 | 2 | 6000 |
| 1 | 3 | 2 | 9000 |
| 2 | 4 | 2 | 10000 |
| 1 | 4 | 2 | 15000 |
| 1 | 3 | 1 | 15000 |
| 1 | 4 | 1 | 25000 |

注意一个细节：查询参数用的是 `DSHH`、`DWXD`，不是「上海虹桥」「无锡东」。买票的两个问题——有没有、多少钱——最终都被翻译成同一件事：**站序上的一个区间**。上海虹桥→无锡东，就是 (1, 3)。整篇讲的就是这个翻译为什么长这样。

## 二、直觉，以及它的三次失败

### 直觉一：用站名定位

「上海虹桥→无锡东」用名字查不是最自然吗？名字会被改、会重名，中文名排序也没有意义。这个项目的演示脚本里，站点编码特意加 D 前缀（DSHH 而不是 SHH），就是为了不撞已有站点的编码。字典表的唯一键落在 `code` 上：编码标识车站，名字只负责展示。`TicketQueryRequest` 里的注释把这条规则写得很直白：

```java
// Station codes, not names, so the lookup stays unambiguous.
@NotBlank
String fromStation,
```

### 直觉二：用时间定位

第二直觉是用出发时间排先后。两个测试事实说明为什么不行。

一是跨天。测试里的 fixture 造了一趟 12-20 23:30 始发、12-21 02:00 终到的车，中间某站 12-21 00:25 才开车。想买 12-21 从中间站上车的人，如果系统按「始发日期」过滤，会查不到这趟车。`TicketQueryIntegrationTests.shouldFilterByBoardingDateRatherThanOriginDate` 验证的正是：过滤按**上车时间**，不按始发时间——查 12-20 查不到中段区间，查 12-21 也查不到全程区间。

二是排序。站序如果当字符串排，`10` 会排在 `2` 前面。`StationQueryMapper` 里的注释：

```java
// Numeric stop order keeps 2 before 10, which string order would break.
```

所以坐标必须是数字型的 `stop_sequence`，而且查询窗口用半开区间 `[dayStart, nextDayStart)`——让每一个时刻只属于一天，不依赖任何时区推理。

### 直觉三：价格现算

第三直觉是价格不用存，查询时算：基价乘里程，或者分段相加。这个项目的选择是把每种组合预存成一行：`(train_trip_id, departure_sequence, arrival_sequence, seat_type)` 上有唯一键，一次精确命中。现算需要的里程表根本不存在；而「分段相加」会把定价能力锁死在线性模型上——演示数据恰好可加（50+40=90），但模型不承诺这一点。

预存的代价是组合数按站数的平方增长，第七节单独说。

## 三、模型：三张表怎么咬合

### stations——字典

```sql
UNIQUE KEY uk_stations_code (code)
```

唯一键只有一条：编码唯一。其余字段（name、spell、region_name）都是展示属性。整张表用 `utf8mb4_0900_ai_ci` 排序规则，编码大小写不敏感——这个特性后面在订单模块还会再出现一次。

### train_trip_stops——坐标系

这一张表承担「第几站」的全部语义，数据库层兜住四件事：

```sql
UNIQUE KEY uk_train_trip_stops_trip_sequence (train_trip_id, stop_sequence),
CONSTRAINT chk_train_trip_stops_sequence CHECK (stop_sequence > 0),
CONSTRAINT chk_train_trip_stops_times CHECK (
    (arrival_at IS NOT NULL OR departure_at IS NOT NULL)
    AND (arrival_at IS NULL OR departure_at IS NULL OR arrival_at <= departure_at)
)
```

一个位置一趟车只能用一次；站序必须为正；每一站至少有一个时间；到达不得晚于开车。首站的 `arrival_at` 和末站的 `departure_at` 允许为 NULL——车总得从某处「无中生有」，再到某处「凭空消失」。

### train_trip_interval_prices——组合表

这张表的约束最有意思，两端各挂一个复合外键：

```sql
CONSTRAINT fk_train_trip_interval_prices_departure
    FOREIGN KEY (train_trip_id, departure_sequence)
    REFERENCES train_trip_stops (train_trip_id, stop_sequence),
CONSTRAINT fk_train_trip_interval_prices_arrival
    FOREIGN KEY (train_trip_id, arrival_sequence)
    REFERENCES train_trip_stops (train_trip_id, stop_sequence),
CONSTRAINT chk_train_trip_interval_prices_order
    CHECK ( arrival_sequence > departure_sequence )
```

意思是：**价格的每一端都必须真实存在于同一趟车的经停表里，且方向必须正向**。想给一趟车插一条 (3, 2) 的反向价、或者引用别的车次的站序，数据库直接拒绝。`TicketPriceIntegrationTests` 里有四个测试专门验证这些约束真的在拦：`shouldRejectReverseOrSameStopInterval`、`shouldRejectSequenceMissingFromThisTrip`、`shouldRejectDuplicateSeatPrice`、`shouldRejectUnsupportedSeatTypeAndNonPositivePrice`。

把不变量列在一起：

1. 同一趟车内，站序唯一；
2. 价格两端的站序必须属于同一趟车；
3. 价格方向必须正向，金额必须为正，坐席类型只能是 0、1、2；
4. 一个「车次 × 区间 × 坐席」组合至多一行价格。

还有一个**不在清单里**的东西：站序连续（1、2、3…n）没有任何 CHECK 保证。它唯一的守卫在应用层，而且只在下单计价时才检查——这是本篇埋下的第一个「我以为」。

### 「我原来以为」之一：时间是坐标

写这篇之前我的直觉是：一张票的核心字段是车次加时间。实际上时间只是每一站的**展示属性**，坐标是站序；过滤按上车时间，排序按上车时间，价格和后续的座位段全部挂在站序上。晚点会让时间不可信，站序不会动。

## 四、关键路径：一次查询的六步

`TrainTripService.searchInterval` 是查询的入口，拆成六步：

**第一步，参数校验。** 起点等于终点直接拒绝，返回 400「起点和终点不能相同」。注意这件事发生在进数据库之前——结构非法的请求没有资格碰 SQL。

**第二步，编码存在性。** `countByCodes` 检查两个编码是否都在字典里，少于 2 个就抛 `StationCodeNotFoundException`，返回 400「出发地或目的地不存在」。注释的理由是：未知的编码连「描述一条路线」都做不到，不必去跑连接查询。

**第三步，区间匹配。** 核心是一条自连接：

```sql
FROM train_trip_stops a
JOIN train_trip_stops b
  ON b.train_trip_id = a.train_trip_id
 AND b.stop_sequence > a.stop_sequence
JOIN stations fs ON fs.id = a.station_id
JOIN stations ts ON ts.id = b.station_id
WHERE fs.code = #{fromCode}
  AND ts.code = #{toCode}
  AND a.departure_at >= #{dayStart}
  AND a.departure_at < #{nextDayStart}
ORDER BY a.departure_at, t.train_number, t.id
```

`b.stop_sequence > a.stop_sequence` 这一个条件同时完成了两件事：匹配「同一趟车上、先上后下」的两个停站，以及把反方向请求天然过滤掉。所以反方向查询不报错，返回 200 加空列表——它不是一个非法请求，只是一个没有结果的合法请求。测试 `shouldRejectReverseDirectionButAllowSameStationAsClientError` 把两种情况摆在一起：反方向是空列表，同站才是 400。

**第四步，空列表短路。** 区间列表为空时直接返回，不去拼价格查询。注释写得很诚实：空列表会拼出 `IN()`，MySQL 会直接拒绝这句 SQL。

**第五步，批量取价与余票。** `findPricesByIntervals` 用一个 `IN` 一次拿回所有区间的价格，`findAvailableSeatsByIntervals` 同样批量算余票——每个座位在该区间的段行全部空闲、且段行数量恰好等于区间长度，才算一张可用的票，再按坐席类型计数。余票的算法细节属于座位模块，第二篇专门拆。

**第六步，内存拼装。** 按 `(train_trip_id, departure_sequence, arrival_sequence)` 分组价格、按坐席类型挂余票，没有配置价格的区间给出空数组——`shouldKeepTripWithoutPricesWithEmptySeatClassList` 验证的是：**没价格不报错，展示为空**，因为查询和下单的严格程度不一样。

下单时的 `priceInterval` 是同一套坐标的另一个消费者，严格得多：全量停站先做**连续性校验**（首末站序之差加一必须等于站数，否则抛 `IncompleteTripStructureException`）；每个编码必须在停站里**恰好出现一次**——零次抛 `InvalidTicketIntervalException`，多于一次抛 `AmbiguousTicketIntervalException`，绝不猜一个；时间上要求到达严格晚于出发；最后精确命中价格行，查不到就抛 `IntervalPriceNotConfiguredException`。代码注释只有一句：

```java
// No fallback to a partial interval or another seat type.
```

查不到 (1, 3) 的二等座价，绝不降级去卖 (1, 2) 加 (2, 3)，也绝不换成一等座。

## 五、失败路径

| 场景 | 谁拦住 | 结果 | 对应测试 |
|---|---|---|---|
| 起点等于终点 | Service 参数校验 | 400「起点和终点不能相同」 | shouldRejectSameDepartureAndArrivalStation |
| 编码不存在 | countByCodes | 400「出发地或目的地不存在」 | shouldRejectUnknownStationCode |
| 方向相反 | 自连接条件 | 200，空列表 | shouldRejectReverseDirection… |
| 区间没有配价 | 查询：坐席不出现；下单：抛异常 | 空数组 / IntervalPriceNotConfiguredException | shouldExposeOnlyConfiguredSeatTypes |
| 时间缺失或倒挂 | DB CHECK（到达≤开车）＋计价时 isAfter | 插入被拒 / IncompleteTripStructureException | shouldRejectStopWithUnknownStation 等 |
| 站序不连续 | **没有 DB 拦截**；计价时连续性校验 | 查询侧余票被少算；下单被拦 | shouldUnderCountWhenStopSequencesAreNotContinuous |
| 同站经停两次 | 计价时唯一性检查 | AmbiguousTicketIntervalException | shouldRejectInvalidAndAmbiguousIntervals |
| 价格为 0、坐席类型非法 | DB CHECK | 插入被拒 | shouldRejectUnsupportedSeatTypeAndNonPositivePrice |

这张表里最值得盯住的是第六行。

## 六、证据与实验

上面每一条结论背后都有测试，33 个测试覆盖了从参数校验到数据库约束的全链路；仓库文档里还留有真实 HTTP 调用的验证记录。但「测试通过」和「我理解了」是两件事，所以留五个实验，每个都能亲手跑：

**实验一：看执行计划。** 对 `findIntervalsByCodesAndDepartureDay` 跑 `EXPLAIN`，确认 stops 自连接走的是 `uk_train_trip_stops_trip_sequence`，字典连接走的是 `uk_stations_code`。

**实验二：拆一条价格。** 删掉 (1, 3) 二等座那行价格，重复第一节的查询——返回里二等座消失，一等座还在；然后直接下单，收 `IntervalPriceNotConfiguredException`。验证「查询宽松、下单严格」的分界。

**实验三：破坏连续性。** 给 D9001 插一行 `stop_sequence = 9` 的假经停（首末差变 8，站数变 5），重跑查询。预期：区间仍然返回，余票数字变化。这就是「查询侧安静地少算」的现场——`shouldUnderCountWhenStopSequencesAreNotContinuous` 的手工版。

**实验四：验证隔离。** 同一个车次号造两个不同日期的实例、各配各的价格，确认查询互不串价——`shouldKeepInstancesOfTheSameTrainNumberApart` 的手工版。车次号不是主键，实例才是。

**实验五：撞 CHECK。** 直接 `UPDATE` 一行价格 `SET price_cents = 0`，数据库拒绝；把坐席类型改成 3，同样拒绝。确认第四节的约束不是摆设。

每个实验记录三样东西：改了什么、预期是什么、实际是什么。和预期不一致的地方，就是下一篇的素材。

## 七、仍存边界

先把没做的事列出来：

**没有数据入口。** 车次、经停、价格都没有管理接口，全部靠测试 fixture 和演示 SQL 手工插入。这是刻意的简化，但也意味着第四节的约束是数据卫生的唯一防线。

**连续性无数据库约束。** 唯一、方向、类型都有 CHECK，唯独「1 到 n 连续」没有。查询侧不报错、只少算，计价侧才拦截。实验三会让这件事现出原形。

**余票只认座位段。** 区间查询的余票按座位段统计，没有座位段行的车次一律显示 0，不读整趟车的数量库存。数量库存车次在这个查询里怎么表现，留到库存那一篇验证。

**组合数按平方增长。** 站数翻倍，价格行数翻四倍。真实 12306 靠里程计价规则压缩这张表，本项目选择不压缩——因为里程根本不存在。

**没有换乘。** 查询只匹配同一趟车上的两个停站，跨车次的组合不在坐标系里。

**时间无时区语义。** DATETIME 不带时区，靠「全表统一本地时间」的约定支撑。系统目前没有跨时区的用户，这个约定没有付出过代价，但它是一笔未结算的债。

## 收束

三句话：

1. 买票的两个问题——有没有、多少钱——都被翻译成「站序上的一个区间」，时间只是展示属性。
2. 价格是预存的组合行，两端被复合外键钉死在同一趟车的经停表上；查不到就拒绝，绝不降级、绝不现算。
3. 数据库兜得住唯一、方向、类型，兜不住连续；连续性是应用层在计价时才检查的假设，查询侧只会安静地少算。

一个未解问题：同一趟车经停同一站两次时，下单侧用 `AmbiguousTicketIntervalException` 拒绝，但查询侧的自连接会把两个区间都列出来。查询列表要不要给歧义区间做标记？目前没有答案，先记录在案。

下一篇进入库存：一座位的段行矩阵，以及那个反直觉的状态——每一段都还有空位，全程却一张票也买不到。
