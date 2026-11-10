// re-export 壳：qq-tool-restrict-owner 的权威实现只有一份，在
// plugins/qq-agent-presets/qq-tool-restrict-owner.mjs（bundle 内，preset 行按包名引用）。
//
// 说明：qq-owner-dsh 与 qq-chat-v2 的工具面策略**相反**（后者无本地工具、前者给 owner 私聊
// 手+眼+脑），所以它不能复用 qq-chat-v2 那份 restrict；这里指向 owner 专属守卫。
//
// DSH 0.1.7 起 ~/.dsh/.agent-presets/<preset>/ 不再被读取，这个路径本身也不再是
// 「装进 DSH 的东西」；保留它只是为了让仓库里按老路径 import/读文件的脚本继续工作。
export * from '../../../plugins/qq-agent-presets/qq-tool-restrict-owner.mjs'
