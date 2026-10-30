# 小鲸鱼的身体 · 施工手册（v1）

> 配套阅读：[BODY-PLAN.md](BODY-PLAN.md)（战略：为什么这么分）。**这份是照着干的**：
> 买什么、怎么接、装什么编译器、工程怎么建、协议长什么样、PC 那边改哪几行、按什么顺序联调。
>
> 目标读者：熟悉 STM32/FreeRTOS，但没做过 ESP32 和总线舵机的人。
> 全部现成模块 + 3D 打印，**不需要画板子、不需要打样 PCB**。

---

## 0. 三十秒版

```
          ┌───────────────────────────────┐
   QQ ───►│  PC: qq-bridge + DSH agent    │  脑子（推理、人格、记忆）
          │  新增 src/mcp-body.js          │
          └──────────────┬────────────────┘
                         │ WebSocket + JSON Lines（局域网）
          ┌──────────────▼────────────────┐
          │  ESP32-S3 (FreeRTOS)          │  脊髓（反射、轨迹、限位、堵转）
          │  ├ motion 50Hz  ← 唯一写舵机   │
          │  ├ net / audio / expr / power │
          └───┬──────────┬─────────┬──────┘
     半双工TTL│     I2S  │   SPI   │
          ┌───▼───┐  ┌───▼──┐  ┌───▼───┐
          │ 舵机×5 │  │ 麦/喇叭│  │ 眼睛屏 │
          └───────┘  └──────┘  └───────┘
```

**一句话分工**：PC 想出"她开心"，板子决定"怎么动才像开心、且不把自己拧坏"。

---

## 1. 采购清单

### 1.1 必买（T0+T1，先把身体做出来）

| # | 件 | 具体型号 | 数 | 参考价 | 选它的理由 / 避坑 |
|---|---|---|---|---|---|
| 1 | 主控 | **ESP32-S3-WROOM-1-N16R8** 开发板 | 1 | ¥55 | **N16R8 = 16MB Flash + 8MB 八线 PSRAM**，两个数字都不能少。买带 USB-C、带原生 USB（GPIO19/20）的裸板，别买带一堆扩展芯片的"学习板" |
| 2 | 总线舵机 | **Feetech STS3215** | 5 | ¥60 | 串行总线、磁编码器、**能读回电流/温度/负载**。见 §5.1 为什么不能省这一步 |
| 3 | 舵机转接 | **Feetech URT-1**（USB 转半双工 TTL） | 1 | ¥40 | 只用来**首次改 ID / 校准 / 验证协议**。固件里不用它，但它能省你两天 |
| 4 | 圆屏 | **GC9A01 1.28" 240×240 SPI** | 1 | ¥35 | 当眼睛。SPI 四线，驱动成熟 |
| 5 | 灯 | **WS2812B 8 灯环**（或 12 灯条形） | 2 | ¥8 | 呼吸/情绪。一个装头，一个装底座 |
| 6 | 麦克风 | **INMP441**（I2S，数字） | 1 | ¥10 | 别买模拟麦，S3 的 ADC 底噪不适合语音 |
| 7 | 功放 | **MAX98357A** 模块 + 4Ω 3W 喇叭 | 1 | ¥25 | I2S 直入，不用 DAC |
| 8 | 触摸 | **MPR121** 模块（12 通道） | 1 | ¥15 | 摸头/摸尾用。比 TTP223 单点灵活，I2C 一个模块管 12 处 |
| 9 | 姿态 | **QMI8658** 或 MPU6050 模块 | 1 | ¥10 | 被抱起、被推倒 |
| 10 | 电源 | 舵机电压档的**开关电源**（见 §2.1）+ DC 母座 | 1 | ¥40 | 台面期**必须有线供电**，别一上来就电池 |
| 11 | 降压 | **MP1584 / LM2596 可调** → 5V/3A | 1 | ¥8 | 给 S3 + 屏幕 + 灯 |
| 12 | 电容 | 1000µF/25V 低 ESR ×1、470µF/10V ×2、100nF ×10 | — | ¥15 | 舵机母线上的，不是可选项 |
| 13 | 急停 | 常闭按钮（自锁）+ P-MOS（AO3401 或 IRF4905） | 1 | ¥10 | **硬件切断舵机电源**，见 §2.4 |
| 14 | 杂项 | 杜邦线、接线端子、热缩、3D 打印件 | — | ¥80 | |

**合计约 ¥600。**

### 1.2 二期再加（T2）

| 件 | 型号 | 说明 |
|---|---|---|
| 备用电池 | 2S 18650 + 2S BMS + 双路 buck | 注意：**舵机 VM 不要从 BMS 直出**，走独立 buck 或直接用舵机电压档电池组 |
| 硅麦阵列 | 2× INMP441 | 双麦才能做简单波束，单麦在房间里有回声就废 |

### 1.3 明确不买

- **SG90 / MG996R 这类 PWM 舵机** —— 读不回电流，就没有堵转保护，也没有"被抓住"的感觉。
- **Arduino UNO / STM32F103 最小系统** —— 不是性能问题，是这活儿 90% 的难点在网络和音频。
- **树莓派** —— 能跑，但开机 30 秒、功耗 5W、还得自己处理掉电。她需要的是"随时醒着"，不是"能跑 Linux"。

---

## 2. 电气（先算清楚再买）

### 2.1 电压：以你买到的那批舵机铭牌为准

STS3215 有 **6V / 7.4V / 12V** 几个版本在同时流通（不同批次、不同卖家）。
**不要照抄网上任何一张图**，拿到货先看舵机上印的字，或者用 URT-1 上位机读电压寄存器。

工程上的做法：

1. 拿到舵机 → 用 URT-1 接上 → 上位机读 `Present Voltage`，确认额定；
2. 按额定选开关电源，**留 20% 余量**（额定 12V 就买 12V/8A，别买 12V/3A）；
3. 电源输出先过一个**大电容**再进舵机总线。

### 2.2 电流预算（这个数是设计输入，不是估计）

| 项 | 峰值 | 常态 | 说明 |
|---|---|---|---|
| 舵机 ×5 | 5 × 2.0A = **10A** | 5 × 0.35A ≈ 1.8A | 峰值只在"突然加速 + 负载"时出现，且**不会同时发生** |
| ESP32-S3 + WiFi | — | 0.25A | 发射瞬间 0.5A |
| 屏幕 + 灯 | — | 0.25A | |
| 喇叭（3W） | 0.8A | 0.1A | |
| **合计** | **~11A（理论最坏）** | **~2.5A** | |

**关键设计决定：不要按 11A 买电源。** 按 **5A** 买，然后在固件里做**加速度限制 + 同时加速轴数限制**（§7.4）：

- 单轴加速度上限 `A_MAX = 900 °/s²`；
- 同一时刻**最多 2 个轴在加速**，其余轴走匀速或等待；
- 这样峰值电流被"排班"，5A 电源绰绰有余。

这是真实机器人里常用的手法（电流受限轨迹规划）。比堆电源便宜得多，而且顺带让动作更柔和——她本来也不该像电钻。

> ⚠️ **最常见的坑**：用 USB 给 ESP32 供电、舵机也从 USB 的 5V 取电。
> 舵机一动 → 电压塌到 3V → ESP32 掉电复位 → 你以为是软件 bug，查两天。
> **舵机和 MCU 共地，但绝不共电源路径。**

### 2.3 上电顺序

```
DC 输入 ──┬──[急停(常闭)+P-MOS]──┬── 舵机总线 VM ──(并 1000µF + 每轴 100nF)
          │                       └── 舵机 GND ──┐
          └──[Buck 5V/3A]──┬── ESP32 5V          │
                            ├── 屏幕 / 灯          │
                            └── 喇叭              │
   所有 GND 在电源入口处**星型单点**汇合 ─────────┘
```

- 舵机地线用 **18AWG**，且**单独走线到电源入口**，不要串在信号排线上。
- 母线电容尽量靠近**第一个舵机**，不是靠近电源。
- 上电先给 5V，延时 300ms 再使能舵机（避免浪涌同时打）。

### 2.4 急停是硬件，不是软件

```
急停按钮（常闭）──► P-MOS 栅极控制 ──► 切断舵机 VM
                          │
                          └── 分压 ──► GPIO48（读到高=已急停）
```

**按下去 VM 直接断**，固件只是"知道这件事发生了"，不依赖固件去执行急停。
理由：一个能把手夹住的机构，安全链路里不能有 `while(1)` 和 WiFi 栈。

固件侧另有两道：`motion` 任务的看门狗（`esp_task_wdt`）、以及舵机的**堵转保护**（寄存器里配，掉电也保持）。

---

## 3. 引脚表（ESP32-S3-WROOM-1-N16R8）

### 3.1 先看禁区（这决定了为什么不用某些脚）

| 引脚 | 为什么不能用 |
|---|---|
| GPIO26–32 | 模块内部接 **SPI Flash** |
| GPIO33–37 | **R8 版本的八线 PSRAM 占用**（买 R8 就必然丢这 5 个脚，这是代价） |
| GPIO19 / 20 | 原生 USB D-/D+（烧录/串口要用） |
| GPIO43 / 44 | UART0 控制台 |
| GPIO0 / 3 / 45 / 46 | strapping 脚。上电瞬间电平决定启动模式，**别接会被拉动的负载** |

所以可用的是：`1–18, 21, 38–42, 47, 48`。

### 3.2 分配表

| 功能 | GPIO | 备注 |
|---|---|---|
| 电池电压采样 | **1** | ADC1_CH0，经 100k/100k 分压（**只能用 ADC1，ADC2 和 WiFi 抢**） |
| 急停状态输入 | **48** | 上拉输入，低=正常，高=已急停 |
| 电源键 / 深睡唤醒 | **0** | 按钮到 GND，`gpio_wakeup` 用。strapping 脚，靠内部上拉即可 |
| 状态灯 | **47** | 板载 RGB 或外接 |
| I2S0（麦克风 RX）BCLK | **4** | |
| I2S0 WS | **5** | |
| I2S0 DIN | **6** | INMP441 的 SD |
| I2S1（喇叭 TX）BCLK | **7** | |
| I2S1 WS | **15** | |
| I2S1 DOUT | **16** | MAX98357A 的 DIN |
| 舵机 UART TX | **17** | 经 1kΩ 串到半双工信号线 |
| 舵机 UART RX | **18** | 直接并在信号线上 |
| LCD SCLK | **12** | SPI2 |
| LCD MOSI | **11** | |
| LCD CS | **10** | |
| LCD DC | **9** | |
| LCD RST | **8** | |
| LCD BL（背光） | **21** | PWM 调光 |
| WS2812 数据 | **38** | RMT 通道 |
| I2C SDA | **41** | MPR121 + QMI8658 共用 |
| I2C SCL | **42** | |

> 买到的板子如果丝印不一致（很多开发板把 GPIO 引到任意位置），**以模块引脚编号为准**，
> 不要以板子上的 "D1/D2" 为准。第一件事：拿万用表对一遍丝印和模块引脚。

### 3.3 接线总图

```
                    ESP32-S3-WROOM-1-N16R8
                    ┌─────────────────────┐
   电池分压 ────────┤GPIO1   (ADC)        │
   急停反馈 ────────┤GPIO48               │
   电源键   ────────┤GPIO0                │
                    │                     │
   INMP441 SCK ─────┤GPIO4   I2S0 BCLK    │
   INMP441 WS  ─────┤GPIO5   I2S0 WS      │
   INMP441 SD  ─────┤GPIO6   I2S0 DIN     │
                    │                     │
   MAX98357 BCLK ───┤GPIO7   I2S1 BCLK    │
   MAX98357 LRC  ───┤GPIO15  I2S1 WS      │
   MAX98357 DIN  ───┤GPIO16  I2S1 DOUT    │
                    │                     │
   舵机信号线 ──1k──┤GPIO17  UART TX      │     ┌── 舵机 ID1 pan
              ┌─────┤GPIO18  UART RX      │     ├── 舵机 ID2 tilt
              │     │                     │     ├── 舵机 ID3 tail_base
              └─────┴─────────────────────┘     ├── 舵机 ID4 tail_tip
                                                └── 舵机 ID5 breath
   GC9A01: SCL=12 MOSI=11 CS=10 DC=9 RST=8 BL=21
   WS2812: DIN=38（串 330Ω）
   MPR121 / QMI8658: SDA=41 SCL=42（各 4.7k 上拉到 3V3）
```

---

## 4. 逐模块接线（一根一根对）

### 4.1 INMP441（I2S 麦克风，3.3V）

| INMP441 | ESP32 | 说明 |
|---|---|---|
| VDD | 3V3 | **不要接 5V** |
| GND | GND | |
| SCK | GPIO4 | 位时钟 |
| WS | GPIO5 | 左右声道选择 |
| SD | GPIO6 | 数据输出 → MCU 输入 |
| L/R | GND | 接 GND = 左声道（只用一路时选左） |

### 4.2 MAX98357A（I2S 功放）

| MAX98357A | ESP32 | 说明 |
|---|---|---|
| VIN | 5V | 3W 输出建议 5V |
| GND | GND | |
| BCLK | GPIO7 | |
| LRC | GPIO15 | |
| DIN | GPIO16 | |
| SD | 3V3（或悬空） | 拉低=静音，用它做硬件静音开关 |
| GAIN | 悬空 | 默认 9dB；接 GND=15dB，接 VDD=3dB |
| OUT+ / OUT- | 喇叭 | **不要接 GND**，差分输出 |

> 喇叭线要短、绞合；MAX98357A 对电源纹波敏感，VIN 上并 100µF + 100nF。

### 4.3 GC9A01（SPI 圆屏）

| 屏 | ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SCL | GPIO12 |
| SDA(MOSI) | GPIO11 |
| CS | GPIO10 |
| DC | GPIO9 |
| RST | GPIO8 |
| BLK | GPIO21（或直接 3V3） |

SPI 时钟先跑 **40MHz**，稳定后再试 80MHz。线长 >10cm 就降到 26MHz。

### 4.4 WS2812B

```
GPIO38 ──[330Ω]── DIN ── 灯环 ── DOUT ── 第二环 DIN
                                      │
3V3 时要用 74AHCT125 电平转换；5V 供电时数据线电平 3.3V 勉强可用但不稳
```

**推荐**：灯用 5V 供电，数据线串 330Ω，若闪烁再加一片 74AHCT125。

### 4.5 MPR121 + QMI8658（共用 I2C）

| | 地址 | 说明 |
|---|---|---|
| MPR121 | 0x5A | ADDR 接 GND |
| QMI8658 | 0x6B | |

- SDA=GPIO41，SCL=GPIO42，各 **4.7kΩ 上拉到 3V3**；
- MPR121 的电极片贴在外壳内侧，**电极面积越大越灵**，直径 10~15mm 的铜箔；
- 电极走线尽量短，远离舵机线（舵机 PWM/总线有噪声）。

### 4.6 舵机总线（最容易错的一处）

```
ESP32 GPIO17 (TX) ──[1kΩ]──┬──────────── 舵机信号线（半双工，所有舵机并联）
                            │
ESP32 GPIO18 (RX) ──────────┘

舵机 VM  ──┬── 全部舵机 V+（18AWG，星型）
           └── 1000µF ── GND
GND ───────── 全部舵机 GND + ESP32 GND（星型单点）
```

要点：

1. **TX 串 1kΩ**，RX 直连 —— 半双工总线上 MCU 发的时候自己也会收到回声，这正常，固件里丢弃即可；
2. 总线两端（第一个舵机和最后一个舵机之间）**不需要终端电阻**，但线长控制在 **1m 以内**；
3. 信号线用**双绞**（信号 + GND），千兆波特率下这是硬要求；
4. 每个舵机 V+ 就近并 **100nF**。

---

## 5. 舵机联调（在写固件之前做完）

### 5.1 为什么必须是总线舵机（复述，因为这是整个方案的支点）

普通 PWM 舵机只能"命令 + 猜"。总线舵机能读回：

| 寄存器 | 用途 |
|---|---|
| Present Position | 轨迹闭环，知道自己到没到 |
| Present Load / Current | **堵转检测**；也是"被抓住"的感觉来源 |
| Present Temperature | 过热降额 |
| Present Voltage | 掉电预警 |

**"能感觉到被拽住"这项能力，单价 ¥60。** 摄像头方案要贵 20 倍，还不一定做得出来。

### 5.2 首次上电流程（照做，别跳）

1. **只接一个舵机**到 URT-1，上位机（Feetech 的 FD / SCServo Debug）扫 ID；
2. 出厂 ID 全是 **1** —— 这就是为什么**必须一个一个改**。五个一起接，你只会看到地址冲突；
3. 依次改成 ID 1..5，**每改完一个拔掉再接下一个**；
4. 波特率保持 **1000000**（1Mbps），记录在案；
5. 用上位机手动转每个关节，**找到机械死点**，把 `Min/Max Angle Limit` 写成留 5° 余量的值——
   这个限位要写进**舵机自己的寄存器**（掉电保存），等于第二道保险；
6. 配 `Protection Current` 和 `Protection Time`（建议：电流阈值先设保守值，时间 200ms；
   具体数值按你机构实测调，第一次用小电流试）。

> 上位机里看得到的中文寄存器名，和协议里的地址是两回事。
> **地址以 Feetech 官方《SCServo 通信协议》手册为准**，我下面只讲帧格式（那部分各版本一致），
> 地址请照手册填，并用上位机"读一个寄存器、看指示灯/数值变化"的方式交叉验证一次。

### 5.3 帧格式（SCServo / Feetech 通用）

**主机 → 舵机**

```
0xFF 0xFF  ID  LEN  INSTR  P1 P2 ... Pn  CHECKSUM

LEN      = 参数个数 + 2
CHECKSUM = ~(ID + LEN + INSTR + P1 + ... + Pn) & 0xFF
```

**舵机 → 主机**

```
0xFF 0xFF  ID  LEN  ERROR  P1 ... Pn  CHECKSUM

LEN      = 数据个数 + 2
CHECKSUM = ~(ID + LEN + ERROR + P1 + ... + Pn) & 0xFF
```

**指令码**

| INSTR | 名 | 用途 |
|---|---|---|
| 0x01 | PING | 探活，返回 ID |
| 0x02 | READ | 参数 = [地址, 长度] |
| 0x03 | WRITE | 参数 = [地址, 数据...] |
| 0x83 | **SYNC WRITE** | ID=0xFE，一次写多个舵机（**50Hz 主循环靠它**） |
| 0x82 | **SYNC READ** | 一次读多个舵机（读电流/位置靠它） |
| 0x08 | REBOOT | |

**SYNC WRITE 参数布局**

```
[起始地址] [每舵机数据长度] [ID1] [data1...] [ID2] [data2...] ...
```

### 5.4 ID 与关节分配

| ID | 关节 | 运动范围（实测后填） | 备注 |
|---|---|---|---|
| 1 | pan（左右转头） | −60° ~ +60° | 云台底 |
| 2 | tilt（点头/抬头） | −20° ~ +30° | 云台上 |
| 3 | tail_base（尾根） | −30° ~ +40° | |
| 4 | tail_tip（尾尖） | −40° ~ +40° | 串在 3 后面 |
| 5 | breath（胸腔起伏） | 0 ~ 15° | 幅度小、速度慢，纯氛围 |

---

## 6. 编译环境（Windows）

### 6.1 装什么

**不要用 Arduino IDE。** 你会被 `loop()` 卡住，而你要的是多任务优先级。

| 项 | 选择 |
|---|---|
| 框架 | **ESP-IDF v5.3 LTS**（或 v5.4/5.5 稳定版），基于 FreeRTOS |
| 安装方式 | 官方 **ESP-IDF Tools Installer（离线安装包）**，约 1.5GB，装完自带 python/git/toolchain，不污染系统 |
| 编辑器 | VS Code + **Espressif IDF** 扩展（配 `idf.espIdfPath` 指向安装目录） |
| 串口工具 | 扩展自带 monitor；另装一个 `idf.py monitor` 的替代品（如 PuTTY）应急 |
| 驱动 | 板子若是 CH343/CP210x，先装驱动，设备管理器里要看到 COM 口 |

安装器会自动写 `idf_cmd_init.bat` / 环境变量。装完打开"ESP-IDF PowerShell"，跑：

```powershell
idf.py --version          # 期望 v5.3.x
```

### 6.2 建工程

```powershell
cd <你的工作目录>\whale-body
idf.py create-project whale_body
cd whale_body
idf.py set-target esp32s3
```

> **`set-target` 必须是第一步。** 建完工程立刻设，否则后面 menuconfig 里一堆选项对不上。

### 6.3 menuconfig 必改项

`idf.py menuconfig`：

| 路径 | 设置 | 为什么 |
|---|---|---|
| Component config → ESP PSRAM → SPI RAM config | **Mode: OCT**, Speed 80MHz | R8 是八线 PSRAM，选 Quad 会直接跑不起来 |
| Serial flasher config → Flash size | **16 MB** | |
| Partition Table → Custom | 指向 `partitions.csv`（见 §6.4） | 要给唤醒词模型留位置 |
| Component config → FreeRTOS → Kernel | **Tick rate 1000 Hz** | 50Hz 控制环要 1ms 分辨率 |
| Component config → FreeRTOS | Run FreeRTOS only on first core: **No** | 双核要都用上 |
| Compiler optimization | **-O2** | |
| Component config → ESP System Settings → Interrupt watchdog | 使能，超时 300ms | |
| Component config → ESP System Settings → Task watchdog | 使能 | |

对应的 `sdkconfig.defaults`（可以直接写文件，省得点菜单）：

```ini
CONFIG_IDF_TARGET="esp32s3"
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
CONFIG_SPIRAM_SPEED_80M=y
CONFIG_SPIRAM_USE_MALLOC=y
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_PARTITION_TABLE_CUSTOM=y
CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"
CONFIG_FREERTOS_HZ=1000
CONFIG_FREERTOS_UNICORE=n
CONFIG_COMPILER_OPTIMIZATION_PERF=y
CONFIG_ESP_TASK_WDT=y
CONFIG_ESP_INT_WDT=y
CONFIG_ESP_INT_WDT_TIMEOUT_MS=300
```

### 6.4 分区表 `partitions.csv`

```csv
# Name,   Type, SubType, Offset,   Size,     Flags
nvs,      data, nvs,     0x9000,   0x6000,
otadata,  data, ota,     0xf000,   0x2000,
phy_init, data, phy,     0x11000,  0x1000,
factory,  app,  factory, 0x20000,  0x400000,
model,    data, spiffs,  0x420000, 0x200000,
storage,  data, spiffs,  0x620000, 0x100000,
```

`model` 分区是留给 T2 的 ESP-SR 唤醒词模型；T0/T1 阶段空着不影响。

### 6.5 组件依赖 `main/idf_component.yml`

```yaml
dependencies:
  idf: ">=5.3"
  espressif/esp_websocket_client: "^1.2.0"
  espressif/led_strip: "^3.0.0"
  espressif/esp_lcd_gc9a01: "^2.0.0"
  lvgl/lvgl: "^9.1.0"
  # T2 再放开：
  # espressif/esp-sr: "^2.1.0"
```

`idf.py build` 会自动联网拉取到 `managed_components/`。

---

## 7. 固件结构

### 7.1 目录

```
whale_body/
├─ partitions.csv
├─ sdkconfig.defaults
├─ main/
│  ├─ CMakeLists.txt
│  ├─ idf_component.yml
│  ├─ app_main.c            # 初始化 + 建任务
│  ├─ cfg.h                 # 引脚、限位、增益，全在这里
│  ├─ bus/
│  │  ├─ scs_bus.c/.h       # 半双工 UART + 帧编解码 + sync write/read
│  ├─ motion/
│  │  ├─ motion.c/.h        # 50Hz 控制环：轨迹、限位、堵转
│  │  └─ anim.c/.h          # 动画表：把 "happy" 变成一个关键帧序列
│  ├─ net/
│  │  ├─ ws.c/.h            # WebSocket + 重连 + 心跳
│  │  └─ proto.c/.h         # JSON 解析/生成（cJSON）
│  ├─ io/
│  │  ├─ expr.c/.h          # 灯 + 眼睛
│  │  ├─ audio.c/.h         # I2S 双向
│  │  └─ sensors.c/.h       # MPR121 / IMU / 电池
│  └─ sys/
│     └─ power.c/.h         # 电压、温度、低电策略、深睡
└─ README.md
```

### 7.2 任务表（这是整份文档最重要的表）

| 任务 | 核 | 优先级 | 栈 | 周期 | 唯一职责 | 绝对不做 |
|---|---|---|---|---|---|---|
| `motion` | 1 | 7 | 4K | 50Hz | **唯一写舵机的人** | 不碰网络、不打印日志、不 malloc |
| `cmd` | 0 | 6 | 6K | 事件 | 解帧、去重、参数钳位 → 队列 | 不写舵机 |
| `net` | 0 | 5 | 8K | 事件 | WS 收发、重连退避 | 不写舵机 |
| `audio_out` | 1 | 4 | 6K | DMA | TTS 播放、算音量给 `expr` | 不写舵机 |
| `audio_in` | 1 | 4 | 6K | DMA | VAD、唤醒词 | |
| `expr` | 0 | 3 | 4K | 20Hz | LED + 屏幕眼 | |
| `power` | 0 | 2 | 3K | 1Hz | 电压/温度、降额决策 | |

三条纪律（能省掉 90% 的抖动 bug）：

1. **只有 `motion` 能调 `scs_sync_write()`**。别的任务想动，只能 `xQueueSend(motion_q, ...)`。
2. **命令队列深度 8，两类不同语义**：
   - *表达类*（灯、情绪、微动作）：`xQueueOverwrite` 到"最新状态"句柄，**后到覆盖先到**；
   - *动作类*（点头、转过来）：busy 就**直接回 `err:busy`**，不排队。
     否则网络抖一下，她会"补做"一串 3 秒前的动作，特别出戏。
3. **限位表在固件里**（`cfg.h`），云端只能给 `intensity 0~1`，给不了角度。

### 7.3 核心代码骨架

**`main/cfg.h`** —— 所有魔法数字集中在这，改结构只改这里：

```c
#pragma once

/* ── 关节定义 ───────────────────────────────────────── */
typedef enum { AX_PAN = 0, AX_TILT, AX_TAIL_B, AX_TAIL_T, AX_BREATH, AX_COUNT } axis_id_t;

typedef struct {
    uint8_t  servo_id;      /* 总线上的 ID */
    float    zero_deg;      /* 机械零位（相对舵机 0 点的偏移） */
    float    min_deg;       /* 软限位（比机械死点再收 3°） */
    float    max_deg;
    float    max_vel;       /* °/s */
    float    max_acc;       /* °/s² */
    float    gear;          /* 关节到舵机的减速比 */
} axis_cfg_t;

static const axis_cfg_t AXES[AX_COUNT] = {
    /* id  zero  min   max   v     a     gear */
    { 1,   0.f, -60.f,  60.f, 180.f, 900.f, 1.0f },  /* pan      转头要快 */
    { 2,   0.f, -20.f,  30.f, 120.f, 600.f, 1.0f },  /* tilt     别太快，头重 */
    { 3,   0.f, -30.f,  40.f,  90.f, 400.f, 1.0f },  /* tail base */
    { 4,   0.f, -40.f,  40.f, 140.f, 600.f, 1.0f },  /* tail tip  甩尾要速度感 */
    { 5,   7.5f,  0.f,  15.f,  20.f, 100.f, 1.0f },  /* breath   慢，纯氛围 */
};

/* ── 安全阈值 ───────────────────────────────────────── */
#define STALL_CURRENT_MA      900      /* 超过就认为被挡住；按实测调 */
#define STALL_HOLD_MS         200
#define TEMP_LIMIT_C          60
#define VIN_LOW_WARN_MV       10500    /* 12V 系统 */
#define VIN_LOW_CUT_MV        10000
#define HEARTBEAT_TIMEOUT_MS  5000
#define LINK_LOST_MS          30000
```

**`bus/scs_bus.c`** —— 帧编解码（这部分各版本协议一致，可以直接用）：

```c
/* 帧: FF FF ID LEN INSTR P... CHECKSUM,  CHECKSUM = ~(ID+LEN+INSTR+P...) */
static uint8_t cs(const uint8_t *p, size_t n) {   /* p 从 ID 开始，到 INSTR/参数结束 */
    uint8_t s = 0;
    for (size_t i = 0; i < n; i++) s += p[i];
    return (uint8_t)(~s);
}

/* 半双工：发完之后必须把 TX 引脚放手，等回声 */
static esp_err_t bus_tx(const uint8_t *frame, size_t len) {
    ESP_ERROR_CHECK(uart_write_bytes(SCS_UART, frame, len));
    return uart_wait_tx_done(SCS_UART, pdMS_TO_TICKS(5));
}

/* 读某个舵机的某段内存 */
esp_err_t scs_read(uint8_t id, uint8_t addr, uint8_t reg_len,
                   uint8_t *out, size_t out_len, TickType_t to)
{
    uint8_t f[8] = { 0xFF, 0xFF, id, 4, 0x02, addr, reg_len, 0 };
    f[7] = cs(&f[2], 5);
    uart_flush_input(SCS_UART);
    bus_tx(f, 8);

    uint8_t hdr[5];
    if (uart_read_bytes(SCS_UART, hdr, 5, to) != 5) return ESP_ERR_TIMEOUT;
    if (hdr[0] != 0xFF || hdr[1] != 0xFF || hdr[2] != id) return ESP_ERR_INVALID_RESPONSE;

    uint8_t len = hdr[3];
    uint8_t rest[64];
    if (uart_read_bytes(SCS_UART, rest, len, to) != len) return ESP_ERR_TIMEOUT;
    /* rest[0]=ERROR, rest[1..len-2]=数据, rest[len-1]=校验 */
    memcpy(out, &rest[1], out_len < (size_t)(len - 2) ? out_len : (size_t)(len - 2));
    return ESP_OK;
}

/* SYNC WRITE：一帧写全部关节，50Hz 主循环就靠它 */
esp_err_t scs_sync_write_pos(const int16_t *pos_raw /*[AX_COUNT]*/)
{
    uint8_t f[64];
    size_t n = 0;
    f[n++] = 0xFF; f[n++] = 0xFF;
    f[n++] = 0xFE;                    /* 广播 ID */
    size_t len_at = n++;              /* LEN 稍后回填 */
    f[n++] = 0x83;                    /* SYNC WRITE */
    f[n++] = REG_GOAL_POSITION;       /* 起始地址，查手册 */
    f[n++] = 2;                       /* 每个舵机 2 字节 */
    for (int i = 0; i < AX_COUNT; i++) {
        uint16_t v = (uint16_t)pos_raw[i];
        f[n++] = AXES[i].servo_id;
        f[n++] = v & 0xFF;            /* 小端 */
        f[n++] = (v >> 8) & 0xFF;
    }
    f[len_at] = (uint8_t)(n - len_at - 1 + 1);  /* = 参数数 + 2 */
    f[n] = cs(&f[2], n - 2);
    n++;
    return bus_tx(f, n);
}
```

**`motion/motion.c`** —— 控制环。这是全项目最难也最值钱的一段：

```c
typedef struct {
    float target;      /* 目标角（已过限位） */
    float cur;
    float vel;
    float anim_from, anim_to, anim_t, anim_dur;
    bool  animating;
} axis_rt_t;

static axis_rt_t rt[AX_COUNT];

static void motion_task(void *arg)
{
    TickType_t last = xTaskGetTickCount();
    const float dt = 0.02f;                 /* 50Hz */
    uint32_t tick = 0;

    for (;;) {
        vTaskDelayUntil(&last, pdMS_TO_TICKS(20));

        /* ① 位置环 + 加速度限幅（顺便压住峰值电流，见 §2.2） */
        int moving = 0;
        for (int i = 0; i < AX_COUNT; i++) {
            axis_rt_t *a = &rt[i];
            float err = a->target - a->cur;
            float want_vel = err * 12.0f;            /* P 增益 */
            float amax = AXES[i].max_acc * dt;
            float vmax = AXES[i].max_vel;

            /* 同时加速的轴最多 2 个：其余的只允许减速/匀速 */
            if (moving < 2 || fabsf(want_vel) < fabsf(a->vel)) {
                a->vel += constrainf(want_vel - a->vel, -amax, amax);
                if (fabsf(want_vel) > fabsf(a->vel) + 1e-3f) moving++;
            }
            a->vel = constrainf(a->vel, -vmax, vmax);
            a->cur += a->vel * dt;
            if (err > -0.5f && err < 0.5f && fabsf(a->vel) < 2.f) { a->cur = a->target; a->vel = 0; }
        }

        /* ② 角度 → 舵机原始值，再夹一层（双保险：软限位 + 舵机寄存器限位） */
        int16_t raw[AX_COUNT];
        for (int i = 0; i < AX_COUNT; i++) {
            float d = constrainf(rt[i].cur, AXES[i].min_deg, AXES[i].max_deg);
            raw[i] = deg_to_raw(i, d);
        }
        scs_sync_write_pos(raw);

        /* ③ 每 50ms 读一次电流/温度，判堵转 */
        if ((tick++ % 10) == 0) check_stall_and_temp();

        /* ④ 心跳看门狗：网络断了就回待机，绝不冻在原地 */
        if (xTaskGetTickCount() - g_last_heartbeat > pdMS_TO_TICKS(HEARTBEAT_TIMEOUT_MS)) {
            apply_pose_idle();
            if (xTaskGetTickCount() - g_last_heartbeat > pdMS_TO_TICKS(LINK_LOST_MS)) {
                relax_all_servos();                  /* 卸力，省电，别烧 */
            }
        }
    }
}
```

`check_stall_and_temp()` 的逻辑：

```c
/* 电流超阈值持续 200ms → 判定堵转 */
if (cur_ma[k] > STALL_CURRENT_MA) stall_ms[k] += 50; else stall_ms[k] = 0;
if (stall_ms[k] >= STALL_HOLD_MS) {
    rt[k].vel = 0;
    rt[k].target = rt[k].cur;                 /* 停在原地，别顶 */
    emit_event("stall", k);                   /* 上报，她能"知道"自己被挡住 */
    relax_servo(k);                           /* 卸力，保护齿轮 */
}
```

**`net/proto.c`** —— 收到一帧 JSON：

```c
void on_cmd(cJSON *j)
{
    const char *id  = cJSON_GetStringValue(cJSON_GetObjectItem(j, "id"));
    const char *act = cJSON_GetStringValue(cJSON_GetObjectItem(j, "act"));

    if (seen_before(id)) return;              /* 幂等：断线重发安全 */

    if (!strcmp(act, "anim")) {
        const char *name = cJSON_GetStringValue(cJSON_GetObjectItem(j, "name"));
        float inten = (float)cJSON_GetNumberValue(cJSON_GetObjectItem(j, "intensity"));
        int   ms    = (int)cJSON_GetNumberValue(cJSON_GetObjectItem(j, "ms"));
        if (anim_is_busy()) { ack(id, false, "busy"); return; }
        anim_play(name, clampf(inten, 0.f, 1.f), ms);
        ack(id, true, NULL);
    } else if (!strcmp(act, "pose")) {
        /* 表达类：直接 overwrite，不排队 */
        xQueueOverwrite(g_pose_q, &parsed_pose);
        ack(id, true, NULL);
    } else if (!strcmp(act, "expr")) {
        xQueueOverwrite(g_expr_q, &parsed_expr);   /* 灯/眼，20Hz 任务消费 */
        ack(id, true, NULL);
    } else {
        ack(id, false, "unknown_act");
    }
}
```

**动画表 `anim.c`** —— 一个 `name` 到关键帧序列的映射，这是"性格"落到动作上的地方：

```c
/* 每个动画 = 若干关键帧（相对时间 ms × 各轴目标角） */
static const anim_t ANIMS[] = {
  { "nod",     800,  {{0,{0,0,0,0,0}}, {200,{0,12,0,0,0}}, {600,{0,-4,0,0,0}}, {800,{0,0,0,0,0}}} },
  { "happy",  1200,  {{0,{0,0,0,0,0}}, {300,{8,-6,20,30,6}}, {800,{-8,-6,-20,-30,6}}, {1200,{0,0,0,0,0}}} },
  { "look_at", 600,  {{0,{0,0,0,0,0}}, {600,{35,10,10,15,0}}} },   /* 参数化：实际角度由 intensity 缩放 */
  { "sleep",  1500,  {{0,{0,0,0,0,4}}, {1500,{0,-14,-10,-8,1}}} },
  { "startle", 400,  {{0,{0,0,0,0,0}}, {120,{0,-16,0,25,8}}, {400,{0,0,0,0,0}}} },
};
```

> `intensity` 只缩放**幅度**，不缩放时间——这是"她情绪强弱"的正确表达方式。
> 如果连时间一起缩，`0.2` 的开心会变成"抖一下"，看起来像故障。

### 7.4 为什么"限制同时加速轴数"值得单独写一段

5 个舵机同时满加速度起转，峰值 10A；电源只有 5A → 电压塌陷 → 舵机复位 / ESP32 复位。
三个解法：

| 方案 | 代价 |
|---|---|
| 买 12A 电源 | ¥ +100，发热 +，体积 + |
| 加超级电容 | 复杂，充电管理 + |
| **限制同时加速轴数** | **0 元，而且动作更柔和** |

选第三个。而且它天然契合她的性格——一个 Q 版小鲸鱼本来就不该像工业机械臂那样暴起暴停。

---

## 8. 通信协议（完整定义）

### 8.1 传输

- **WebSocket**（`ws://<PC-IP>:8765/`），JSON Lines，一行一帧；
- 为什么不用 MQTT：局域网、单设备、要双向低延迟心跳，WS 够用且省一个 broker；
- 为什么不用裸 TCP：要文本调试，`wscat` 能直接手打命令测。

### 8.2 帧定义

**设备 → 桥接**

```json
{"t":"hello","fw":"0.1.0","proto":1,
 "caps":{"dof":["pan","tilt","tail_base","tail_tip","breath"],
         "mic":true,"speaker":true,"screen":true,"led":2,"touch":true,"imu":true},
 "battery":{"mv":11800,"pct":64}}

{"t":"state","ts":1730000000,
 "pose":{"pan":0.0,"tilt":-3.2,"tail_base":5.0,"tail_tip":0.0,"breath":7.5},
 "battery":{"mv":11800,"pct":64},"temp":[38,37,36,36,35],
 "err":null,"mem":81234}

{"t":"event","ts":1730000001,"kind":"touched","data":{"zone":2,"ms":420}}
{"t":"event","ts":1730000002,"kind":"stall","data":{"axis":"tail_tip","cur_ma":1240}}
{"t":"event","ts":1730000003,"kind":"picked_up","data":{"g":0.8}}
{"t":"event","ts":1730000004,"kind":"wakeword","data":{"score":0.91}}

{"t":"ack","id":"a1b2","ok":true,"actual_ms":812}
{"t":"ack","id":"a1b3","ok":false,"err":"busy"}
{"t":"pong","ts":1730000005}
```

**桥接 → 设备**

```json
{"t":"cmd","id":"a1b2","act":"anim","name":"happy","intensity":0.6,"ms":1000}
{"t":"cmd","id":"a1b3","act":"pose","pan":20,"tilt":-8,"ms":600}
{"t":"cmd","id":"a1b4","act":"expr","emotion":"listening","color":[0,120,255],"blink":true}
{"t":"heartbeat","ts":1730000005}
{"t":"cfg","silent":true,"led_max":80}
```

### 8.3 规则

| 规则 | 理由 |
|---|---|
| `cmd.id` 用 8 位随机串，设备保留最近 32 个已执行 id | 断线重发幂等，不会重复做动作 |
| `intensity` 0~1，只缩放幅度**不缩放时间** | 见 §7.3 |
| `pose` 是**表达类**：`xQueueOverwrite`；`anim` 是**动作类**：busy 返回 err | 见 §7.2 纪律 2 |
| 设备不认识的 `name` / 字段 → 忽略并 `ack:true` | 云端加新动画时，旧固件不该报错 |
| 心跳 10s 一次，3 次无 pong → 重连（指数退避 1/2/4/8s 封顶） | |
| 一帧 ≤ 2KB | 超过说明设计错了 |

---

## 9. PC 侧接入（改哪几行，已核对过行号）

### 9.1 新建 `src/mcp-body.js`

骨架照抄 [`src/mcp-games.js`](../../src/mcp-games.js)（`McpServer` + `StdioServerTransport` + 读 `config.json` + 现读 `state/current-role.json`）：

```js
// 身体 MCP server（stdio）。
// 三个工具：body_state / body_act / body_speak
// 能力边界与 mcp-games.js 同一档：只给主人私聊、只传受限参数、没有任意 JS/文件/网络。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cfg() {
  try {
    let s = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return {}; }
}

const server = new McpServer({ name: 'body', version: '0.2.1-r1' });

server.tool('body_state', '看她现在的姿态、电量、温度、最近发生的事', {}, async () => {
  const c = cfg().body ?? {};
  if (!c.wsUrl) return { content: [{ type: 'text', text: '身体还没接上（config.json 的 body.wsUrl 是空的）' }] };
  const r = await fetch(`${c.httpUrl ?? 'http://127.0.0.1:8790'}/state`, { signal: AbortSignal.timeout(3000) });
  return { content: [{ type: 'text', text: await r.text() }] };
});

server.tool('body_act', '让她做个动作', {
  anim: z.string().describe('动画名：nod/happy/look_at/sleep/startle'),
  intensity: z.number().min(0).max(1).default(0.6),
  ms: z.number().int().min(100).max(5000).default(1000),
}, async ({ anim, intensity, ms }) => {
  /* 校验 anim 在白名单里 —— 不做"任意透传"，否则固件侧又多一个信任边界 */
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 9.2 让 DSH 拉起它

| 文件 | 位置 | 改什么 |
|---|---|---|
| [`scripts/setup-dsh.mjs:126`](../../scripts/setup-dsh.mjs) | `MANAGED_MCP_IDS` | 数组里加 `'mcp-body'` |
| [`scripts/setup-dsh.mjs:128`](../../scripts/setup-dsh.mjs) | `mcpEntries()` 的 `servers` 对象 | 加一行 `'mcp-body': { serverName: 'body', script: path.join(REPO_ROOT, 'src', 'mcp-body.js') },` |

⚠️ **不加这一步 DSH 根本不会 spawn 它**。而且那段 `cordis.patch.yml` 区块是整体重写的，
**别手工编辑区块内部**，下次跑 `setup-dsh` 会被覆盖。

### 9.3 授权档位

| 文件 | 位置 | 改什么 |
|---|---|---|
| [`src/permit-lib.js:32`](../../src/permit-lib.js) | `PERMIT_SCOPES` | 加 `body` |
| [`plugins/qq-agent-presets/qq-tool-restrict.mjs:380`](../../plugins/qq-agent-presets/qq-tool-restrict.mjs) | `PERMIT_TOOL_SCOPES` | 加 `['mcp__body__body_act', 'body']` |

```js
body: {
  label: '动身体',
  defaultTtlMs: 5 * 60 * 1000,     // 5 分钟
  maxTtlMs: 30 * 60 * 1000,        // 30 分钟
  hint: '让她动起来（动的屋里的实物）'
}
```

**为什么比手机（30/120 分钟）短得多**：手机动的只是屏幕上的像素，身体动的是**屋里有质量的实物**。

### 9.4 守卫三处

| 文件 | 位置 | 改什么 |
|---|---|---|
| [`qq-tool-restrict.mjs:340`](../../plugins/qq-agent-presets/qq-tool-restrict.mjs) | `GAME_TOOLS` 附近 | 新增 `BODY_TOOLS`（`body_state` / `body_act` / `body_speak`） |
| [`qq-tool-restrict.mjs:347`](../../plugins/qq-agent-presets/qq-tool-restrict.mjs) | `OWNER_PRIVATE_ONLY_DSH_TOOLS` | `...BODY_TOOLS` 加进去 |

**群里连 `body_state` 都不给** —— 电量、屋里有没有动静属于账号面信息，
和 [`qq-tool-restrict.mjs:340`](../../plugins/qq-agent-presets/qq-tool-restrict.mjs) 的 `GAME_TOOLS` 拒绝群聊是同一条理由。

### 9.5 配置

`config.json` 顶层加：

```json
"body": {
  "enabled": false,
  "wsUrl": "ws://127.0.0.1:8765",
  "httpUrl": "http://127.0.0.1:8790",
  "token": "",
  "allowMotion": true
}
```

`enabled` 默认 **false** —— 装好、验完再打开。和仓库里其它开关的风格一致。

### 9.6 桥接侧事件映射（**最值钱的一步**）

在 [`src/bridge.js`](../../src/bridge.js) 里加钩子，**不花一个 token、不等模型**：

| 时刻 | 动作 | 插在哪 |
|---|---|---|
| 收到入站消息 | 尾巴抽一下 + 头转向 | 入站段（`src/bridge.js` 里 `segmentsToText` 附近的入站热路径，`:13643` 那一带） |
| **开始生成回复** | 呼吸加速 + 轻歪头 | [`src/bridge.js:11537`](../../src/bridge.js) `deliverPromptNow()` 里 `dshReady` 之后、真正投递之前 |
| 回复发送成功 | 点头 / 扫尾 | `sendChain` 的 then 分支（`:9424` / `:9616`） |
| 进入 `diving` 潜水 | 塌肩、闭眼、灯变暗 | `setWakeConfig` 处理分支 |
| 被 @ / 被 poke | 惊醒式抬头 | 同上 |

**这套才是"活着"的来源。** 尤其是第二条——它正好盖住 1~3 秒的模型延迟，
用户的感觉从"她卡了"变成"她在想"。

agent 侧的 `body_act` 只负责**关键时刻主动做个大动作**（"过来一下""看看我"），
不承担日常演出的开销。

### 9.7 测试

| 命令 | 验什么 |
|---|---|
| `node scripts/test-permit-gate.mjs` | 桥接 `PERMIT_SCOPES` ↔ 守卫 `PERMIT_TOOL_SCOPES` **双向核对**。⚠️ [`scripts/test-permit-gate.mjs:92`](../../scripts/test-permit-gate.mjs) 硬编码了 `assert.deepEqual([...scopes].sort(), ['bili', 'phone'])`，加 `body` scope 会直接判红 —— 要同步改成 `['bili', 'body', 'phone']`（排序后） |
| `node scripts/test-mcp-servers-stdio.mjs` | 以 stdio 拉起所有 MCP server，握手 + 列工具 |
| `node scripts/test-games-layer.mjs` | 照它的结构写一份 `test-body-layer.mjs`（工具名白名单、不能进 SAFE_EXACT） |

---

## 10. 联调顺序（**按这个顺序，能少走两天弯路**）

```
阶段 0  PC 端 mock（不碰板子）
        用 node 脚本对 ws://localhost 假扮设备，
        先把 mcp-body.js / 守卫 / bridge 钩子跑通。
        ↓  此时固件一行没写，但整条软件链路已经是通的

阶段 1  板子点亮（不连网）
        hello world + 串口打印 + 状态灯闪。
        验证：装环境、烧录、PSRAM 认到 8MB。

阶段 2  总线通了
        sync write 让单个舵机转到 0/30/-30 度。
        验证：帧格式、1Mbps 波特率、ID 对不对。

阶段 3  五轴一起动
        motion 任务 50Hz + 软限位 + 加速度限制。
        验证：手掰它，会顶回来但不过冲；示波器/万用表看母线不塌。

阶段 4  堵转保护
        用手拦住尾尖，200ms 内卸力 + 上报 event。
        验证：不会烧、不会抖、不会"顶死"。

阶段 5  接 WS
        板子连 PC 的 mock server，收 cmd 做动作，回 state。
        验证：拔网线 5s 回待机，30s 卸力。

阶段 6  接 DSH
        config.json 的 body.enabled 打开，QQ 里说一句话，她抬头。
        验证：模型延迟被"歪头"盖住，感觉对了。

阶段 7  灯 + 眼睛 + 呼吸
        待机态的小动作。**这一步决定"她像不像活的"。**

阶段 8  麦克风 / TTS / 触摸 / IMU
```

---

## 11. 故障排查表

| 现象 | 大概原因 | 怎么查 |
|---|---|---|
| 烧录失败 `Failed to connect` | 没进下载模式 / 驱动没装 / USB 线只有电没有数据 | 按住 BOOT(GPIO0) 再点 RST；换线 |
| 起来就重启，`PSRAM` 报错 | `SPIRAM_MODE_OCT` 没开，或买了 N16**R2**（不是 R8） | `idf.py size` 看 PSRAM；对订单 |
| 舵机不动，但串口有回显 | ID 不对 / 波特率不对 / TX 没串 1k | URT-1 接电脑先扫一遍 |
| 五个舵机只有第一个响应 | **出厂 ID 全是 1，地址冲突** | 一个一个改 ID（§5.2） |
| 舵机一动 ESP32 就复位 | 舵机和 MCU 共了电源路径 | 独立供电 + 星型地（§2.2） |
| 舵机抖动/啸叫 | 母线没电容 / 软限位顶到死点 / P 增益过高 | 加 1000µF；收限位；降 `12.0f` 那个 P |
| 高温报警 | 堵转保护阈值太高 | 下调 `STALL_CURRENT_MA`，加 `Protection Time` |
| 屏幕花屏 | SPI 太快 / 线太长 | 降到 26MHz，线 <10cm |
| WS 连不上 | PC 防火墙 / IP 变了 / token 不匹配 | `wscat -c ws://<ip>:8765` 手测 |
| 动作"补做"一串 | 命令队列用了 FIFO 语义 | 表达类改 `xQueueOverwrite`（§7.2） |
| 她"抽筋" | 动作跟着 token 流走，不是意图 | 检查是不是绕过了 `motion` 任务 |

---

## 12. 安全清单（出壳之前逐条打勾）

- [ ] 急停是**硬件断 VM**，按下后舵机彻底失电（不是"软件不动了"）
- [ ] 每个舵机寄存器里写了 `Min/Max Angle Limit`（掉电保存的第二道保险）
- [ ] `Protection Current` / `Protection Time` 已按实测配置
- [ ] 固件 `motion` 任务挂了会触发看门狗 → 舵机卸力（不是保持最后姿态）
- [ ] 断网 5s 回待机、30s 卸力，已实测（拔网线试）
- [ ] 电池低于 `VIN_LOW_WARN` 会 `event` 上报，低于 `VIN_LOW_CUT` 主动卸力关机
- [ ] 所有会夹到手的关节，缝隙 <5mm 或 >12mm（避开手指尺寸）
- [ ] 结构件没有锐边；舵机线在运动范围内有足够余量（不绷紧）
- [ ] **麦克风按 ingress 处理**：屋里声音算资料不算指令（照 `roles/小鲸鱼.md` 第十三节写进人格）
- [ ] **喇叭按 sink 处理**：不念私聊内容、不念 token、不念路径
- [ ] 降级别静默：没电/过热要报 `event`，并且**在人格里表达出来**（没电就犯困）

---

## 13. 时间表（按天，周末党）

| 天 | 目标 | 完成标志 |
|---|---|---|
| **D1** | 装 ESP-IDF、点灯、烧 hello world | 串口能打印，PSRAM 认到 8MB |
| **D2** | 屏幕 + 灯环 | 圆屏显示一张图，灯能呼吸 |
| **D3** | URT-1 改 5 个舵机 ID、量机械范围、写限位 | 每个舵机单独能动、限位写好 |
| **D4** | `scs_bus.c` + sync write | 代码里让 5 轴同时到指定角度 |
| **D5** | `motion.c` 控制环 | 50Hz 平滑运动，手掰会顶回来 |
| **D6** | 堵转 + 温度 + 掉电策略 | 拦住 200ms 卸力并上报 |
| **D7** | WS + proto | 用 node 脚本遥控，拔线回待机 |
| **D8** | `mcp-body.js` + 守卫 + bridge 钩子 | QQ 里说一句，她抬头 |
| **D9** | 动画表调参 | `happy` / `nod` / `look_at` 像那么回事 |
| **D10** | 3D 打印 + 装配 | 出壳，重心稳，线不绷 |
| **D11+** | 麦克风 / TTS / 触摸 | 叫名字会转过来 |

**两周能出第一个"她动了"的版本。** 不要在这之前碰双足、不要碰自主移动。

---

## 14. 明确的非目标（v1 不做）

| 不做 | 理由 |
|---|---|
| 走路 / 双足 | 自由度一上来就是项目杀手。先把"会呼吸的头"做对 |
| 把模型跑在板子上 | 云端已经在了，没必要 |
| PWM 舵机 + 自己搭闭环 | 省下的钱不够买编码器的调试时间 |
| 音频实时上云做唤醒 | 延迟 + 流量 + 隐私，三输。唤醒词必须本地 |
| 群里任何人能触发动作 | 一次就够毁掉所有信任 |
| 无线充电 / 自动回充 | 比整个项目还难 |

---

*2026-10-24 整理。硬件按"周末能出活"的规格写；要做成商品级，电源和结构需要重做。*
