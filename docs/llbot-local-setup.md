# 本机 LLBot 登录与启动

已在这台 WSL Ubuntu 上安装官方 LLBot 8.3.2，使用无头模式和随包 Node.js 24.13.0。用户后台服务 `wavelength-llbot.service` 已启用；无需另外打开桌面 QQ。

管理页面为 <http://localhost:3080>。Satori 配置为 `ws://127.0.0.1:5600/v1/events`，仅监听本机。网站已准备监听群 **1127561791**，同一人最后一次有效作答为准，展示前 5 名。尚未登录 QQ 时，Satori 端口不会启动，网站显示未连接属于正常状态。

## 首次登录

1. 打开 <http://localhost:3080>。管理密码保存在 `/home/tonrac/.local/share/wavelength/llbot/webui-password.txt`；可在 WSL 终端执行下面的命令查看。它是本机管理页面的密码，不是 QQ 密码。

   ```bash
   cat /home/tonrac/.local/share/wavelength/llbot/webui-password.txt
   ```

2. 到 LLBot 官方认证站 <https://auth.luckylillia.com> 登录，获取自己的 Auth Token。回到本机管理页，在 Auth Token 输入框中填入并保存。令牌在本机录入，不需要发到聊天中。
3. 按页面提示用手机 QQ 扫码并确认登录；该 QQ 账号需要已加入群 `1127561791`。认证站若要求审核，需先完成它的流程。认证成功后才会进入 QQ 登录。
4. 在 WSL 终端执行一次网站启用脚本：

   ```bash
   bash /home/tonrac/code/wavelength/scripts/enable-qq-service.sh
   ```

   脚本为现有系统服务添加私有配置路径，然后重启网站。终端会要求输入本机 sudo 密码；重启会清空进行中的对局。此步骤完成前，当前运行的网站仍使用旧配置。
5. 打开 <http://localhost:3100>，进入联网游戏。出题人关闭目标后，用另一个群成员账号发送 `g67%` 或 `g67.5%`。机器人自己的消息会被忽略；揭晓后停止收答，下一轮清空榜单。具体 UI 展示由前端接入工作负责。

## 日常启动与查看状态

在 WSL 终端运行：

```bash
systemctl --user start wavelength-llbot.service
sudo systemctl start wavelength.service
```

LLBot 已设置随用户服务管理器启动；关闭整个 WSL 后，需先重新启动 WSL。QQ 是否能自动恢复登录取决于保存的会话是否仍有效；失效时回到管理页重新扫码。

```bash
# 状态
systemctl --user status wavelength-llbot.service
systemctl status wavelength.service

# LLBot 日志
journalctl --user -u wavelength-llbot.service -n 80 --no-pager

# 重启 LLBot
systemctl --user restart wavelength-llbot.service

# 改了网站配置后重启网站（会清空当前对局）
sudo systemctl restart wavelength.service

# 停止 QQ 接入
systemctl --user stop wavelength-llbot.service
```

## 本机文件

所有 QQ 会话、令牌和竞猜历史放在网站目录之外，目录权限为仅当前用户可访问：

| 用途 | 路径 |
| --- | --- |
| 网站配置 | `/home/tonrac/.local/share/wavelength/config.json` |
| 历史竞猜 JSONL | `/home/tonrac/.local/share/wavelength/qq-rounds.jsonl` |
| 管理页面密码 | `/home/tonrac/.local/share/wavelength/llbot/webui-password.txt` |
| LLBot 程序 | `/home/tonrac/.local/share/wavelength/llbot/runtime/bin/llbot/` |
| LLBot 默认配置 | 程序目录中的 `default_config.json` |
| QQ 会话与账户配置 | 程序目录中的 `data/`，登录后生成 `config_<QQ号>.json` |
| LLBot 用户服务 | `/home/tonrac/.config/systemd/user/wavelength-llbot.service` |
| 网站服务配置覆盖 | 启用脚本创建 `/etc/systemd/system/wavelength.service.d/50-qq.conf` |

Satori 令牌已随机生成并在两端保持一致。LLBot 官方 Auth Token 是另一个令牌，需本人从官方认证站获取。修改 WebUI 密码后，本地 `webui-password.txt` 只是初始密码备忘，不会自动更新。

安装包来自 [LLBot 官方 v8.3.2 发布](https://github.com/LLOneBot/LuckyLilliaBot/releases/tag/v8.3.2)，下载后已核对 GitHub 提供的 SHA-256。运行时直接启动官方核心，使管理页能在首次填入 Auth Token 前打开。参考：[官方安装说明](https://luckylillia.com/guide/choice_install)、[官方配置说明](https://luckylillia.com/guide/config)。
