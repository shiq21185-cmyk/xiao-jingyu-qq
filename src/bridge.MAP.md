# bridge.js 结构地图

> 自动生成于 2026/10/27 18:31:07。**改代码前先查这里**，别通读全文。
> 重新生成：`node scripts/mapgen.mjs`（或 `npm run map`）

## 规模

- 总行数：**17107**
- 顶层函数：**74** 个
- `main()` 内嵌函数：**276** 个
- `main()` 占 **14828 行（87%）** —— 这就是"文件太大"的主体

## 文件分区

| 行段 | 内容 |
| --- | --- |
| 1–95 | import + 常量 |
| 96–2229 | 顶层工具函数（JSON 读写、角色卡、preset、日志、脱敏…） |
| **2230–17057** | **`main()` 主体（87%）** |
| 17058–17107 | 启动：`main().catch(...)` + 进程级钩子 |

## 顶层函数

| 行号 | 函数 | 约行数 |
| --- | --- | --- |
| 107 | `resolveDiaryDir` | 18 |
| 125 | `diaryDir` | 23 |
| 148 | `diaryViewerDir` | 22 |
| 170 | `rebuildDiaryViewer` | 84 |
| 254 | `normalizeBodyConfig` | 43 |
| 297 | `findBodyTool` | 13 |
| 310 | `findBodyProbeScript` | 14 |
| 324 | `bodySetMode` | 54 |
| 378 | `bodyProbe` | 79 |
| 457 | `normalizeModeInput` | 8 |
| 465 | `readJsonSafe` | 18 |
| 483 | `readDailyMemory` | 10 |
| 493 | `dailyMemoryScopeLabel` | 29 |
| 522 | `parseMemoryDay` | 106 |
| 628 | `searchDailyMemory` | 102 |
| 730 | `readConfigObject` | 14 |
| 744 | `renameWithRetry` | 17 |
| 761 | `atomicWriteJson` | 14 |
| 775 | `atomicWriteText` | 13 |
| 788 | `loadOrCreateConsoleToken` | 31 |
| 819 | `hardenStateDirAcl` | 17 |
| 836 | `readActivityTail` | 10 |
| 846 | `listRoles` | 21 |
| 867 | `applyRoleInjectLimit` | 14 |
| 881 | `applyImpressionTraitChars` | 5 |
| 886 | `impressionTraitMaxChars` | 12 |
| 898 | `roleFilePath` | 4 |
| 902 | `firstMeaningfulLine` | 8 |
| 910 | `roleWarnings` | 22 |
| 932 | `roleSummaries` | 29 |
| 961 | `validateRoleName` | 9 |
| 970 | `validateRoleContent` | 10 |
| 980 | `readRoleContent` | 4 |
| 984 | `writeRoleContent` | 17 |
| 1001 | `presetSourceYaml` | 4 |
| 1005 | `dshHomeDir` | 4 |
| 1009 | `installedPresetYaml` | 11 |
| 1020 | `readPresetPromptText` | 11 |
| 1031 | `presetBackupPrefix` | 4 |
| 1035 | `backupPresetFile` | 15 |
| 1050 | `listPresetBackups` | 12 |
| 1062 | `presetStatus` | 17 |
| 1079 | `isSilentMarker` | 7 |
| 1086 | `isSendToolName` | 33 |
| 1119 | `rememberAgentToken` | 21 |
| 1140 | `forgetAgentToken` | 18 |
| 1158 | `normalizeReasoningEffort` | 10 |
| 1168 | `redactSensitiveText` | 13 |
| 1181 | `escapeCqText` | 5 |
| 1186 | `unquoteJsonString` | 14 |
| 1200 | `appendActivity` | 6 |
| 1206 | `readRoleState` | 3 |
| 1209 | `writeRoleState` | 3 |
| 1212 | `sanitizeRoleName` | 5 |
| 1217 | `normalizeOwnerQQ` | 11 |
| 1228 | `normalizeIdList` | 14 |
| 1242 | `decodeShellOutput` | 33 |
| 1275 | `loadConfig` | 531 |
| 1806 | `loadState` | 28 |
| 1834 | `saveState` | 21 |
| 1855 | `consolePortInUse` | 16 |
| 1871 | `acquireLock` | 63 |
| 1934 | `releaseLock` | 23 |
| 1957 | `createCappedLogger` | 29 |
| 1986 | `localClock` | 8 |
| 1994 | `log` | 19 |
| 2013 | `withTimeout` | 13 |
| 2026 | `describeJsonCard` | 37 |
| 2063 | `segmentsToText` | 66 |
| 2129 | `extractMediaFromSegments` | 26 |
| 2155 | `allowed` | 12 |
| 2167 | `canonicalV2Key` | 26 |
| 2193 | `parsePermitAnswer` | 37 |
| 2230 | `main` | 14878 |

## `main()` 内部密度

（每 1000 行有几个内嵌函数；密度高的地方是功能密集区，改之前多读几行）

| 行段 | 内嵌函数 | 代表 |
| --- | --- | --- |
| 2230–3229 | 36 | transcribeVoiceSegments, stickerEnabled, saveStickerStoreSafe, photoEnabled |
| 3230–4229 | 31 | sendVoiceForV2, speakForV2, speakOrTextV2, sendStickerV2 |
| 4230–5229 | 33 | modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode |
| 5230–6229 | 2 | startCallWatch, startConsoleServer |
| 6230–7229 | 0 | — |
| 7230–8229 | 0 | — |
| 8230–9229 | 0 | — |
| 9230–10229 | 0 | — |
| 10230–11229 | 0 | — |
| 11230–12229 | 36 | redactKnownTokensOnly, sendToQQ, lastSendSucceeded, singleLineForQQ |
| 12230–13229 | 33 | sendMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply |
| 13230–14229 | 42 | prunePromises, formatPromisesV2, schedulePromiseV2, formatMemoryV2 |
| 14230–15229 | 32 | pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2, isQuoteTargetSelf |
| 15230–16229 | 25 | startV2TurnWatchdog, isConversationBusyV2, isAutonomousWakeReason, quietGrantMs |
| 16230–17057 | 6 | handlePokeNotice, registerPending, pumpMux, applyHealedTokens |

## 内嵌函数全表

<details><summary>点开（276 个）</summary>

| 行号 | 函数 | 约行数 |
| --- | --- | --- |
| 2273 | `transcribeVoiceSegments` | 55 |
| 2328 | `stickerEnabled` | 4 |
| 2332 | `saveStickerStoreSafe` | 19 |
| 2351 | `photoEnabled` | 3 |
| 2354 | `photoCollectEnabled` | 28 |
| 2382 | `photoRateOk` | 13 |
| 2395 | `saveMediaLibSafe` | 13 |
| 2408 | `captureMessagePhotos` | 53 |
| 2461 | `sendLocalImageV2` | 41 |
| 2502 | `sendPhotoV2` | 95 |
| 2597 | `fileDir` | 8 |
| 2605 | `fileDayDir` | 15 |
| 2620 | `uniquePath` | 20 |
| 2640 | `findInDownloads` | 20 |
| 2660 | `fileLimitBytes` | 6 |
| 2666 | `checkFileQuota` | 10 |
| 2676 | `noteFileSend` | 7 |
| 2683 | `guessFileNameFromUrl` | 11 |
| 2694 | `sanitizeFileName` | 10 |
| 2704 | `gatewayUploadFile` | 36 |
| 2740 | `sendFileV2` | 101 |
| 2841 | `applyPhotoNoteV2` | 10 |
| 2851 | `syncStickerLibrary` | 31 |
| 2882 | `listStickersForV2` | 7 |
| 2889 | `getStickerImageData` | 30 |
| 2919 | `assertOutboundAuditOk` | 10 |
| 2929 | `voiceCfg` | 17 |
| 2946 | `voiceLibrary` | 22 |
| 2968 | `voicePathInsideLibrary` | 7 |
| 2975 | `resolveVoicePathForV2` | 76 |
| 3051 | `resolveVoicePathForOperator` | 19 |
| 3070 | `voiceBudgetCheck` | 14 |
| 3084 | `voiceBudgetCommit` | 14 |
| 3098 | `sendVoiceV2` | 85 |
| 3183 | `recordVoiceSentV2` | 30 |
| 3213 | `verifyVoiceMessageSent` | 35 |
| 3248 | `sendVoiceForV2` | 50 |
| 3298 | `speakForV2` | 60 |
| 3358 | `speakOrTextV2` | 78 |
| 3436 | `sendStickerV2` | 77 |
| 3513 | `applyStickerNoteV2` | 13 |
| 3526 | `setStickerRemarkV2` | 21 |
| 3547 | `collectStickerV2` | 46 |
| 3593 | `saveSlangStore` | 14 |
| 3607 | `queueSlangTask` | 5 |
| 3612 | `ensureSlangLearnerSession` | 38 |
| 3650 | `invalidateSlangLearnerSession` | 11 |
| 3661 | `waitLearnerTurn` | 16 |
| 3677 | `runSlangExtraction` | 62 |
| 3739 | `runSlangResearch` | 54 |
| 3793 | `maybeQueueSlangExtraction` | 15 |
| 3808 | `feedSlangWindow` | 14 |
| 3822 | `allowSlangSubmit` | 18 |
| 3840 | `publicSlangEntry` | 16 |
| 3856 | `confirmedSlangListV2` | 9 |
| 3865 | `withSlangContext` | 45 |
| 3910 | `fetchModelCatalog` | 71 |
| 3981 | `rememberModel` | 26 |
| 4007 | `noteCacheAttribution` | 33 |
| 4040 | `recordSessionUsage` | 22 |
| 4062 | `recordSessionSnapshot` | 33 |
| 4095 | `rebuildInFlightCollector` | 35 |
| 4130 | `armPendingWakeLease` | 10 |
| 4140 | `disarmPendingWakeLease` | 5 |
| 4145 | `clearAllPendingWakeLeases` | 43 |
| 4188 | `refreshMode` | 40 |
| 4228 | `refreshPresetList` | 14 |
| 4242 | `modeAllowed` | 19 |
| 4261 | `resolvePresetName` | 15 |
| 4276 | `modePreset` | 13 |
| 4289 | `isSessionAllowedInCurrentMode` | 6 |
| 4295 | `sessionPolicy` | 4 |
| 4299 | `isCurrentSession` | 11 |
| 4310 | `stopRetiredSessionWork` | 18 |
| 4328 | `forgetConversationCaches` | 11 |
| 4339 | `retireSession` | 43 |
| 4382 | `reconcileSessionPolicies` | 161 |
| 4543 | `startDshWatch` | 61 |
| 4604 | `noteUpstreamPacket` | 6 |
| 4610 | `noteReceiveHealth` | 9 |
| 4619 | `snowlumaHealthSnapshot` | 35 |
| 4654 | `reportSnowlumaHealth` | 22 |
| 4676 | `pollSnowlumaStatus` | 26 |
| 4702 | `startSnowlumaWatch` | 23 |
| 4725 | `injectConsoleToken` | 12 |
| 4737 | `v2ToolEnabled` | 17 |
| 4754 | `disabledByOwner` | 53 |
| 4807 | `callSidecarFetch` | 37 |
| 4844 | `endCall` | 22 |
| 4866 | `callRerouteTextIfInCall` | 26 |
| 4892 | `callDeliverTurn` | 72 |
| 4964 | `dropCallWaiter` | 17 |
| 4981 | `bodyDeliverTurn` | 63 |
| 5044 | `resolveCallTurn` | 17 |
| 5061 | `startCallSidecar` | 40 |
| 5101 | `stopCallSidecar` | 47 |
| 5148 | `callOwnerNames` | 9 |
| 5157 | `callFriendNameMap` | 46 |
| 5203 | `callIdentifyCaller` | 19 |
| 5222 | `callWatchTick` | 132 |
| 5354 | `startCallWatch` | 11 |
| 5365 | `startConsoleServer` | 5961 |
| 11326 | `redactKnownTokensOnly` | 13 |
| 11339 | `sendToQQ` | 23 |
| 11362 | `lastSendSucceeded` | 5 |
| 11367 | `singleLineForQQ` | 9 |
| 11376 | `splitLongSegment` | 79 |
| 11455 | `isCjkChar` | 13 |
| 11468 | `splitByCjkSpaces` | 23 |
| 11491 | `planSocialTimeline` | 27 |
| 11518 | `sendBurstToQQ` | 44 |
| 11562 | `onebotSend` | 41 |
| 11603 | `mimeFromBuffer` | 9 |
| 11612 | `mimeFromUrl` | 13 |
| 11625 | `getImageDimensions` | 48 |
| 11673 | `base64FromMaybe` | 33 |
| 11706 | `mediaLimit` | 24 |
| 11730 | `wardrobeConfig` | 13 |
| 11743 | `loadWardrobe` | 45 |
| 11788 | `todayKeyLocal` | 5 |
| 11793 | `readOutfitState` | 9 |
| 11802 | `saveOutfitState` | 10 |
| 11812 | `outfitOfToday` | 17 |
| 11829 | `pinOutfit` | 15 |
| 11844 | `resolveOutfitPath` | 33 |
| 11877 | `isSafeLocalMediaPath` | 14 |
| 11891 | `isProbablySafeImageFileRef` | 11 |
| 11902 | `fetchOneBotImage` | 74 |
| 11976 | `emojiCdnFallbackEnabled` | 15 |
| 11991 | `emojiCdnCandidates` | 11 |
| 12002 | `emojiIdFromFileName` | 5 |
| 12007 | `fetchFaceMedia` | 54 |
| 12061 | `resolveMediaList` | 42 |
| 12103 | `fetchMediaData` | 55 |
| 12158 | `mediaHintFor` | 8 |
| 12166 | `findMessageMedia` | 30 |
| 12196 | `clampGapV2` | 6 |
| 12202 | `computeGapsV2` | 30 |
| 12232 | `sendMessagesV2` | 49 |
| 12281 | `shouldAuditKey` | 8 |
| 12289 | `captureSendGuard` | 12 |
| 12301 | `shouldBlockSilentReply` | 6 |
| 12307 | `auditAndSend` | 31 |
| 12338 | `ensureChatModel` | 57 |
| 12395 | `ensureSession` | 161 |
| 12556 | `emulatorCfg` | 14 |
| 12570 | `sleepMs` | 5 |
| 12575 | `runEmulatorManager` | 24 |
| 12599 | `emulatorRunning` | 17 |
| 12616 | `emulatorStartForGrant` | 27 |
| 12643 | `emulatorStopIfWeStarted` | 25 |
| 12668 | `markGrantEmulatorFlag` | 9 |
| 12677 | `sweepExpiredEmulatorGrants` | 32 |
| 12709 | `readPermits` | 5 |
| 12714 | `writePermits` | 13 |
| 12727 | `normalizeSpeakerIdsV2` | 16 |
| 12743 | `defaultWakeConfigV2` | 36 |
| 12779 | `refreshDefaultWakeConfigV2` | 17 |
| 12796 | `refreshAllDefaultWakeConfigsV2` | 16 |
| 12812 | `hasExplicitEndV2` | 7 |
| 12819 | `isSleepingConfigV2` | 6 |
| 12825 | `preSleepWaitBlockedV2` | 16 |
| 12841 | `computeWakeSafetyV2` | 15 |
| 12856 | `ensureWakeableV2` | 31 |
| 12887 | `deleteConversationKeepingMemory` | 26 |
| 12913 | `getSocialV2State` | 55 |
| 12968 | `loadSocialV2State` | 143 |
| 13111 | `saveSocialV2State` | 42 |
| 13153 | `formatParticipationV2` | 36 |
| 13189 | `suggestQuietMsV2` | 37 |
| 13226 | `normalizePromiseAt` | 7 |
| 13233 | `prunePromises` | 10 |
| 13243 | `formatPromisesV2` | 27 |
| 13270 | `schedulePromiseV2` | 34 |
| 13304 | `formatMemoryV2` | 36 |
| 13340 | `appendMemoryV2` | 104 |
| 13444 | `isSocialEnabled` | 4 |
| 13448 | `socialState` | 8 |
| 13456 | `isDirectAddress` | 14 |
| 13470 | `isDirectedAtAi` | 17 |
| 13487 | `isMustReplyText` | 10 |
| 13497 | `appendRecentMessage` | 18 |
| 13515 | `appendSummary` | 9 |
| 13524 | `buildContextBlock` | 6 |
| 13530 | `enterActive` | 21 |
| 13551 | `cancelSocialTimers` | 7 |
| 13558 | `cancelAllSocialTimers` | 8 |
| 13566 | `cleanupSocialForModeChange` | 16 |
| 13582 | `leaveActive` | 8 |
| 13590 | `buildBatchPrompt` | 10 |
| 13600 | `buildProbePrompt` | 6 |
| 13606 | `buildActiveExitPrompt` | 9 |
| 13615 | `triggerActiveDurationExit` | 25 |
| 13640 | `buildProactivePrompt` | 8 |
| 13648 | `deliverPromptNow` | 116 |
| 13764 | `deliverPrompt` | 12 |
| 13776 | `processPromptQueue` | 23 |
| 13799 | `scheduleSocialReply` | 17 |
| 13816 | `socialLoopTick` | 118 |
| 13934 | `startSocialLoop` | 6 |
| 13940 | `flushSummaries` | 56 |
| 13996 | `roleRawContent` | 32 |
| 14028 | `roleHintForMode` | 5 |
| 14033 | `currentRoleHint` | 9 |
| 14042 | `roleHintForCurrentMode` | 7 |
| 14049 | `isCjkLikeChar` | 14 |
| 14063 | `convertExampleSpacesToComma` | 25 |
| 14088 | `findCjkSpaceWarning` | 24 |
| 14112 | `findSplitBoundaryWarning` | 21 |
| 14133 | `currentRoleHintV2` | 33 |
| 14166 | `pruneGroupMemberNameCache` | 15 |
| 14181 | `assertGroupMember` | 26 |
| 14207 | `resolveGroupMemberName` | 36 |
| 14243 | `pruneReplyInfoCache` | 11 |
| 14254 | `resolveReplyInfo` | 67 |
| 14321 | `resolveReplyTargetV2` | 39 |
| 14360 | `isQuoteTargetSelf` | 12 |
| 14372 | `appendSocialV2Message` | 77 |
| 14449 | `appendSocialV2Poke` | 50 |
| 14499 | `recordSentMessagesV2` | 26 |
| 14525 | `readFeedbackEntries` | 5 |
| 14530 | `appendFeedbackEntry` | 11 |
| 14541 | `readToolLog` | 16 |
| 14557 | `appendToolLog` | 32 |
| 14589 | `redactSensitive` | 16 |
| 14605 | `sanitizeToolArgs` | 21 |
| 14626 | `evaluateWakeTriggerV2` | 39 |
| 14665 | `readThroughSeqV2` | 16 |
| 14681 | `noteModelMessagesV2` | 10 |
| 14691 | `requestedReadThroughSeqV2` | 12 |
| 14703 | `acknowledgeMessagesV2` | 14 |
| 14717 | `buildWakeSnapshotV2` | 38 |
| 14755 | `replyTimingV2` | 22 |
| 14777 | `selfIdentityTextV2` | 12 |
| 14789 | `buildWakePromptV2` | 150 |
| 14939 | `diaryNudgeTargetKey` | 13 |
| 14952 | `diaryNudgeTick` | 55 |
| 15007 | `startDiaryNudge` | 17 |
| 15024 | `startEmulatorSweep` | 9 |
| 15033 | `buildWakeReminderPromptV2` | 11 |
| 15044 | `sendWakePromptV2` | 111 |
| 15155 | `cancelReplyCheckV2` | 7 |
| 15162 | `scheduleReplyCheckV2` | 26 |
| 15188 | `isTurnStaleV2` | 10 |
| 15198 | `reapStaleTurnV2` | 32 |
| 15230 | `startV2TurnWatchdog` | 15 |
| 15245 | `isConversationBusyV2` | 44 |
| 15289 | `isAutonomousWakeReason` | 43 |
| 15332 | `quietGrantMs` | 23 |
| 15355 | `qzoneWriteMinGapMs` | 10 |
| 15365 | `qzoneWriteGapCheck` | 11 |
| 15376 | `qzoneWriteMark` | 12 |
| 15388 | `scheduleQuietAutonomy` | 39 |
| 15427 | `cancelQuietAutonomy` | 20 |
| 15447 | `isAutonomousTurnActive` | 21 |
| 15468 | `wakePriorityV2` | 30 |
| 15498 | `scheduleWakeV2` | 74 |
| 15572 | `canSteerV2` | 19 |
| 15591 | `steerIntoRunningTurnV2` | 27 |
| 15618 | `setupSleepTimerV2` | 38 |
| 15656 | `cancelProactiveCheckV2` | 7 |
| 15663 | `scheduleProactiveCheckV2` | 55 |
| 15718 | `clearSocialV2Timers` | 27 |
| 15745 | `clearAllSocialV2Timers` | 9 |
| 15754 | `drainPromptQueue` | 8 |
| 15762 | `drainAllPromptQueues` | 8 |
| 15770 | `handleIncoming` | 383 |
| 16153 | `cancelPendingEntry` | 32 |
| 16185 | `answerPermitRequest` | 9 |
| 16194 | `handlePendingAnswer` | 56 |
| 16250 | `handlePokeNotice` | 60 |
| 16310 | `registerPending` | 20 |
| 16330 | `pumpMux` | 606 |
| 16936 | `applyHealedTokens` | 55 |
| 16991 | `syncTokenToFile` | 8 |
| 16999 | `healTokenIfStale` | 109 |

</details>

## 已抽出的模块


| 文件 | 内容 | 原位置 |
| --- | --- | --- |
（暂无。2026-10-20 试拆过 `src/qq-text.js`，后来按主人决定回滚了 —— 见下方「关于拆分」）

## 拆分时踩过的坑（务必记住）

1. **搬函数必须连常量一起搬，并查"还有谁在用那个常量"**。
   `REASONING_EFFORT_OPTIONS` 搬走后 bridge 里还有 4 处在用，忘了导出 ⇒ `/api/dsh/model` 500。
   查法：搜常量名看**全部**出现点，不是只看定义处。
2. **加 import 不能只看"行首是 import 的行"**。
   多行 import 的中间行不以 `import` 开头，按行首判断会把新 import 插进别人中间 ⇒ 语法错。
3. **审计 harness 要跟着改**：`scripts/audit-bridge-harness.mjs` 用 `...sensitive` 那种写法
   把各模块导出摊进 VM 上下文，新模块不摊进去 ⇒ 测试里 `XXX is not defined`。
4. **改完必须跑全量** `node scripts/test-audit.mjs`。
   上面两个错都**不在正常聊天路径上**，手动试发现不了，只有测试能抓。
5. **别用大括号配平算 main() 边界**：字符串/正则里的 `{` 会骗过它。