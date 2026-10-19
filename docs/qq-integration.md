# QQ 群竞猜：LLBot / Satori

后端连接 LLBot 的 Satori 服务，收集指定群内的竞猜。当前前端由 UI 工作统一接入；本文定义配置、SSE 数据及后端存档，不要求特定 DOM 或布局。

## 启用

需要 Node.js 22.22.2 或更高版本，先运行 `npm ci`。复制根目录的 `config.example.json` 为 `config.json`（已有配置则合并 `qq` 部分，保留网站密码）：

```json
{
  "password": "网站访问密码",
  "qq": {
    "enabled": true,
    "groupId": "123456789",
    "url": "ws://127.0.0.1:5500/v1/events",
    "token": "与 LLBot 中配置的 Satori 令牌相同",
    "topN": 5,
    "guessPolicy": "last"
  }
}
```

1. 使用 LLBot 登录已经加入目标群的 QQ 账号，启用它的 Satori 服务。
2. `groupId` 填 QQ 群号。`url` 填后端可访问的完整 Satori WebSocket 地址；示例端口是占位示例，以 LLBot 设置为准。两者不在同一机器时，将 `127.0.0.1` 改为运行 LLBot 的机器地址；支持 `wss://` 和反向代理的路径前缀。
3. `token` 与 LLBot 保持一致；上游未设置令牌时可以为空。地址中不放令牌，令牌只通过 Satori IDENTIFY 发送。
4. 启动／重启 `node server.js`，进入联网游戏。配置需重启生效；功能默认关闭。

后端主动连接 LLBot，不需要配置反向 WebSocket 地址，也不会向 QQ 群发送消息。已适配 LLBot 的 `llonebot` 平台标识，同时兼容 `qq` 标识。

## 作答规则

- 出题人关闭目标、进入讨论拨杆阶段后开始收答，锁定拨杆和猜左右期间仍可修改。主持人的揭晓操作被后端处理时立即截止；在此之后才到达的消息不计入，即使其发送时间较早。
- 发送完整纯文本 `g-50%`、`g0%` 或 `g+50%`；范围为 −100～+100，最左 −100%、正中 0%、最右 +100%，最多一位小数。正数也可省略 `+`。支持 `G`、前后空白及全角 `％`。附带其他文字、引用、@、图片等内容不作为作答。
- 同一 QQ 用户只占一个名额，默认以最后一次有效作答为准。无效新消息不会清除此前的答案；撤回消息暂不撤销答案。可配置 `guessPolicy: "first"` 改为首次有效，但本活动默认使用 `last`。
- 误差按真实目标中心计算，保留 0.1 个百分点，不先将目标四舍五入为整数。误差相同则最终作答较早者优先；秒级发送时间相同时按 Satori 事件时间、后端接收顺序排序。
- `topN` 默认 5，可配置为 1–10。人数不足时只展示实际参与者；没有有效作答时榜单为空。
- 下一轮、重新开始会清空当前作答。使用消息 ID 去重，并核对发送时间和事件时间，防止重连补发串入下一轮。LLBot 的发送时间只有秒级精度，因此收答开启的同一秒还会用毫秒级事件时间判断。
- 后端和 LLBot 所在机器应同步系统时间。重连会携带上次事件序列号尝试恢复会话；能否补发断线期间的消息取决于上游版本，客户端不能恢复上游未保存的消息。

## 前端接口

沿用受网站认证保护的 `GET /api/stream`，每个游戏状态增加 `audience`，不新增前端提交作答 API：

```json
{
  "enabled": true,
  "percentScale": "signed",
  "connected": true,
  "groupId": "123456789",
  "topN": 5,
  "guessPolicy": "last",
  "accepting": false,
  "revealed": true,
  "count": 23,
  "targetPct": 34,
  "winners": [
    {
      "rank": 1,
      "nickname": "群友的名片",
      "avatarUrl": "https://q1.qlogo.cn/g?b=qq&nk=12345&s=100",
      "guessPct": 34.1,
      "errorPct": 0.1
    }
  ]
}
```

- 揭晓前 `targetPct` 固定为 `null`，`winners` 固定为空数组；`count` 是不同作答者的人数，不是消息条数。个人作答轨迹不进入 SSE。
- `connected` 表示 Satori 已鉴权，且上游至少一个 QQ 登录账号在线；不代表已验证机器人加入指定群。连接断开不会清空已收到的答案，恢复后继续当前轮收答。
- `nickname` 优先取群名片，其次用户昵称、用户名、QQ 号占位。前端须作为文本渲染，不拼接 HTML。昵称最长 80 个 UTF-16 单元。
- 头像使用上游提供的 HTTPS 地址；不可用时使用 QQ 的 HTTPS 头像地址。加载失败时由前端显示占位头像。
- `guessPct`、`targetPct` 使用 −100～+100 的百分比数字；`percentScale: "signed"` 标记此刻度。`errorPct` 是新刻度下的**百分点差**，范围 0～200。终局 `phase: "over"` 同样包含本轮榜单。
- 功能关闭、本地热座或静态托管时不展示群竞猜；联网断线提示及等待／空榜／终局展示由 UI 处理。

## 历史记录

每个已揭晓轮次在 `data/qq-rounds.jsonl` 写一行 JSON，默认目录已加入 `.gitignore`。可通过 `WL_QQ_RESULTS=/absolute/path/qq-rounds.jsonl` 改变位置。数据、配置、设备会话、后端源码均不由网站静态服务公开。

新记录的 `version` 为 2，`percentScale` 为 `signed`。已有 version 1 的记录保留原始 0～100 刻度，不重写；分析混合版本时，旧百分比需乘 2 再减 100，旧误差乘 2。新记录包含：

| 字段 | 含义 |
|---|---|
| `gameId`、`roundId`、`round` | 唯一对局 ID、唯一轮次 ID、游戏内轮数；重开游戏或重启后不会复用 ID |
| `groupId`、`guessPolicy` | 群号与本轮重复作答规则 |
| `openedAt`、`revealedAt` | 开始收答和揭晓的 Unix 毫秒时间 |
| `question` | 题库名、所选题目两端文字、行动队伍、队伍名称、是否加时 |
| `targetPct`、`dialPct` | 真实目标位置与队伍最终拨杆位置 |
| `count` | 有效作答人数 |
| `ranking` | **全体**作答者的最终答案、误差及排名，不限前五名 |
| `submissions` | 按接收顺序保存的全部有效作答，包含同一人的多次修改 |

作答项包含 `userId`、`nickname`、`avatarUrl`、`messageId`、`guessPct`、`value`、`sentAt`、`eventAt`、`receivedAt`、`sequence`；`value` 使用游戏内部的 0–1000 刻度（群友答案可取半格），其余位置百分比字段使用 −100～+100。三个时间分别是 QQ 消息发送时间、Satori 事件时间及后端接收时间，单位为毫秒。`ranking` 额外包含 `rank` 和 `errorPct`。

这些数据可用于比较改答案前后的误差、统计题目难度及分析参与时间。普通聊天、无效消息、被过滤的重复／过期消息、网站密码及 Satori 令牌不入档。

记录按顺序异步追加并刷新到磁盘，不阻塞揭晓。写盘失败时保留待写轮次，每 5 秒重试，并输出错误日志。未成功落盘的队列只保存在内存，强制退出或持续写盘失败时可能丢失。已成功落盘的数据跨重启保留；进行中的轮次不恢复，未揭晓就重开或退出的轮次不归档。当前不提供历史查询 API、分析页面或自动清理。

## 验证

```bash
npm run test:qq
npm test
```

QQ 专项测试覆盖规则、全体作答及修改轨迹存档、写盘失败恢复、模拟 Satori 鉴权／心跳／重连、SSE 排名及私有文件保护，不依赖真实 QQ 账号。真实群联调需完成上面的 LLBot 配置；前端布局由 UI 工作验证。

实现参考：[ne-danmaku Satori 接入](https://github.com/PKUOriginalFire/ne-danmaku/blob/main/nekocast_danmaku/danmaku/satori_client.py)、[Satori 事件协议](https://satori.chat/zh-CN/protocol/events.html)、[LLBot 事件实现](https://github.com/LLOneBot/LLOneBot/blob/main/src/satori/adapter.ts)及[消息转换](https://github.com/LLOneBot/LLOneBot/blob/main/src/satori/utils.ts)。
