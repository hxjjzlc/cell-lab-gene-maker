<h1 align="center">Cell Lab 基因制作器</h1>

<p align="center">
  <a href="README.md"><b>中文</b></a> ｜ <a href="README.en.md">English</a>
</p>

> **本项目内容由 AI 生成，生成模型为 DeepSeek V4.1flash1017。**
> 代码与文档均为模型输出，经实际基因文件导入游戏验证；使用时请自行判断。

一个零依赖的 `.genome` 基因组工具，用于手机游戏《细胞实验室 / Cell Lab》。配方 JSON 与游戏存档二进制之间双向转换，附带生长树绘制和结构模拟。核心是单个 JS 文件，Node、浏览器、App 内置 JS 引擎都能跑，不依赖 zlib、Buffer 或任何 npm 包。

## 能做什么

- 把配方 JSON 编译成游戏可导入的 `.genome`
- 读取真实基因文件，导出结构化参数（JSON）
- 结构体检：段数、版本、子模式越界、模式身份冲突
- 画生长树，看每个模式会长成什么、在哪一层断链
- 结构模拟：无光照无食物的理想环境下，最终连成几个整体、各自组成比例、鞭毛出生即死

## 两代格式

| 代 | 容器 | 版本 | 段长 | 说明 |
|---|---|---|---|---|
| 旧版 | 裸 Java 流（`AC ED 00 05` 开头） | v95 / v3055 | 315 / 331 字节 | 原版 Cell Lab，v95 = 40 槽，v3055 = 127 槽 |
| 新版 | ZIP 容器（`PK` 开头，内含 `save.bin` + `thumbnail.png`） | v3145 / v3169 | 1125 / 1212 字节 | Cell Lab: Macro，段数 = 实际模式数 |

同一个游戏版本只认一种容器。新版游戏导入旧格式会「识别失败」，旧版游戏读不了新格式，这是最常见的导入失败原因。

## 目录

```
celllab.js                    核心：读写两代格式、ZIP、inflate/deflate、树、模拟
cli.js                        命令行入口
SKILL.md                      给 AI 助手用的技能说明（字段表、格式细节、实战坑）
references/classic-mechanics.md   细胞类型机制、免疫表、参数范围
presets/*.json                四个现成配方
dist/*.genome                 对应编译好的基因文件
```

## 快速开始

需要 Node（无第三方依赖）。

```bash
node cli.js types                       # 细胞类型表
node cli.js presets                     # 内置配方
node cli.js make presets/swimmer.json -o swimmer.genome
node cli.js read swimmer.genome         # 解析，自动识别新旧格式
node cli.js verify swimmer.genome       # 结构体检
node cli.js tree presets/swimmer.json   # 生长树
node cli.js sim  presets/swimmer.json --max-cells 150
```

格式由命令行或配方里的 `format` 决定：

```bash
node cli.js make 配方.json -o out.genome --format modern   # Macro
node cli.js make 配方.json -o out.genome                   # 原版裸流
```

手上有真实导出时，用 `--template` 继承版本号、段长、尾部结构（新版连缩略图一起），只替换配方里写明的参数：

```bash
node cli.js make 配方.json -o out.genome --template sample.genome
```

## 配方

```json
{
  "format": "modern",
  "name": "简易游泳者",
  "modes": [
    { "type": "phagocyte",    "color": [0.75,0.9,0.35], "splitMass": 2.5, "children": [1,2], "makeAdhesin": true },
    { "type": "flagellocyte", "color": [0.95,0.55,0.2], "splitMass": 3.6, "swimForce": 0.6, "children": [1,2] }
  ]
}
```

字段：`type` `color` `splitMass` `splitRatio` `splitAngle` `child1Angle` `child2Angle` `children` `makeAdhesin` `child1KeepAdhesin` `child2KeepAdhesin` `priority` `adhesinStiffness` `maxConnections`，以及按类型区分的 `swimForce` `density` `muscle*` `stemThreshold*` `secreteType` `smell*` `signals` `virusFrom/virusTo` `values`。

完整字段表、两代段布局逐字节对照、细胞类型机制，见 `SKILL.md` 与 `references/classic-mechanics.md`。

## 三条容易踩的线

- 普通细胞 3.6ng 封顶，脂肪细胞 21.6ng；分裂质量滑条到不了 3.672 以上，写 3.672 就是「永不分裂」。
- 功能细胞（神经、感觉、立体感、鞭毛、粘附、角质）不摄食，一律给 3.672，硬设低门槛只会反复尝试、把能量耗在半路。
- 新版的段内偏移 1174 是一个模式身份字节，必须全局唯一；配方直出会撞身份，真机上表现为「导入成功、一进培养皿就闪退」。用真实导出克隆段，再写唯一身份。

## 已知限制

- 新版格式 511 字节之后的 10 个细胞类型参数块按原样保留，不解析其中语义。
- 模拟是几何近似，不含推力、流体、软体形变、饥饿，只回答连通关系与组成比例。
- Macro 新增的细胞类型（神经节、发光、刺细胞等）编号尚未与游戏逐一对齐，读取时显示为「类型 N（Macro 新增）」。

## 许可

MIT。
