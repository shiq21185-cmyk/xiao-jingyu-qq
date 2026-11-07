# bridge.js 结构地图

> 自动生成于 2026/11/7 16:04:38。**改代码前先查这里**，别通读全文。
> 重新生成：`node scripts/mapgen.mjs`（或 `npm run map`）

## 规模

- 总行数：**18278**
- 顶层函数：**85** 个
- `main()` 内嵌函数：**281** 个
- `main()` 占 **15317 行（84%）** —— 这就是"文件太大"的主体

## 文件分区

| 行段 | 内容 |
| --- | --- |
| 1–95 | import + 常量 |
| 96–2911 | 顶层工具函数（JSON 读写、角色卡、preset、日志、脱敏…） |
| **2912–18228** | **`main()` 主体（84%）** |
| 18229–18278 | 启动：`main().catch(...)` + 进程级钩子 |

## 顶层函数

| 行号 | 函数 | 约行数 |
| --- | --- | --- |
| 102 | `resolveDiaryDir` | 18 |
| 120 | `diaryDir` | 23 |
| 143 | `diaryViewerDir` | 22 |
| 165 | `rebuildDiaryViewer` | 105 |
| 270 | `normalizeBodyConfig` | 54 |
| 324 | `findBodyTool` | 13 |
| 337 | `findBodyProbeScript` | 14 |
| 351 | `bodySetMode` | 54 |
| 405 | `bodyProbe` | 67 |
| 472 | `bodySay` | 75 |
| 547 | `camUartState` | 11 |
| 558 | `camUartStart` | 39 |
| 597 | `camUartStop` | 38 |
| 635 | `normalizeModeInput` | 8 |
| 643 | `readJsonSafe` | 18 |
| 661 | `readDailyMemory` | 10 |
| 671 | `dailyMemoryScopeLabel` | 29 |
| 700 | `parseMemoryDay` | 106 |
| 806 | `searchDailyMemory` | 205 |
| 1011 | `recallIdOf` | 13 |
| 1024 | `pickRecallRows` | 116 |
| 1140 | `renderRecallBlock` | 24 |
| 1164 | `readConfigObject` | 14 |
| 1178 | `renameWithRetry` | 17 |
| 1195 | `atomicWriteJson` | 14 |
| 1209 | `atomicWriteText` | 13 |
| 1222 | `loadOrCreateConsoleToken` | 31 |
| 1253 | `hardenStateDirAcl` | 17 |
| 1270 | `readActivityTail` | 10 |
| 1280 | `listRoles` | 21 |
| 1301 | `applyRoleInjectLimit` | 14 |
| 1315 | `applyImpressionTraitChars` | 5 |
| 1320 | `impressionTraitMaxChars` | 12 |
| 1332 | `roleFilePath` | 4 |
| 1336 | `firstMeaningfulLine` | 8 |
| 1344 | `roleWarnings` | 22 |
| 1366 | `roleSummaries` | 29 |
| 1395 | `validateRoleName` | 9 |
| 1404 | `validateRoleContent` | 10 |
| 1414 | `readRoleContent` | 4 |
| 1418 | `writeRoleContent` | 17 |
| 1435 | `presetSourceYaml` | 4 |
| 1439 | `dshHomeDir` | 4 |
| 1443 | `installedPresetYaml` | 11 |
| 1454 | `readPresetPromptText` | 11 |
| 1465 | `presetBackupPrefix` | 4 |
| 1469 | `backupPresetFile` | 15 |
| 1484 | `listPresetBackups` | 12 |
| 1496 | `presetStatus` | 17 |
| 1513 | `isSilentMarker` | 7 |
| 1520 | `isSendToolName` | 33 |
| 1553 | `rememberAgentToken` | 21 |
| 1574 | `forgetAgentToken` | 18 |
| 1592 | `normalizeReasoningEffort` | 10 |
| 1602 | `redactSensitiveText` | 13 |
| 1615 | `escapeCqText` | 5 |
| 1620 | `unquoteJsonString` | 14 |
| 1634 | `appendActivity` | 6 |
| 1640 | `readRoleState` | 3 |
| 1643 | `writeRoleState` | 3 |
| 1646 | `sanitizeRoleName` | 5 |
| 1651 | `normalizeOwnerQQ` | 11 |
| 1662 | `normalizeIdList` | 14 |
| 1676 | `decodeShellOutput` | 60 |
| 1736 | `runPowerShellEncoded` | 20 |
| 1756 | `runProcessEncoded` | 124 |
| 1880 | `wrapInputScript` | 20 |
| 1900 | `parseFgMarks` | 32 |
| 1932 | `VK_EXPR` | 13 |
| 1945 | `loadConfig` | 580 |
| 2525 | `loadState` | 28 |
| 2553 | `saveState` | 21 |
| 2574 | `consolePortInUse` | 16 |
| 2590 | `acquireLock` | 63 |
| 2653 | `releaseLock` | 23 |
| 2676 | `createCappedLogger` | 29 |
| 2705 | `localClock` | 8 |
| 2713 | `log` | 19 |
| 2732 | `withTimeout` | 13 |
| 2745 | `describeJsonCard` | 37 |
| 2782 | `segmentsToText` | 66 |
| 2848 | `extractMediaFromSegments` | 26 |
| 2874 | `allowed` | 12 |
| 2886 | `canonicalV2Key` | 26 |
| 2912 | `main` | 15367 |

## `main()` 内部密度

（每 1000 行有几个内嵌函数；密度高的地方是功能密集区，改之前多读几行）

| 行段 | 内嵌函数 | 代表 |
| --- | --- | --- |
| 2912–3911 | 40 | transcribeVoiceSegments, stickerEnabled, saveStickerStoreSafe, photoEnabled |
| 3912–4911 | 30 | voicePathInsideLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck |
| 4912–5911 | 34 | rememberModel, noteCacheAttribution, recordSessionUsage, recordSessionSnapshot |
| 5912–6911 | 11 | dropCallWaiter, bodyDeliverTurn, resolveCallTurn, startCallSidecar |
| 6912–7911 | 0 | — |
| 7912–8911 | 0 | — |
| 8912–9911 | 0 | — |
| 9912–10911 | 0 | — |
| 10912–11911 | 0 | — |
| 11912–12911 | 15 | redactKnownTokensOnly, sendToQQ, lastSendSucceeded, singleLineForQQ |
| 12912–13911 | 36 | isSafeLocalMediaPath, isProbablySafeImageFileRef, fetchOneBotImage, emojiCdnFallbackEnabled |
| 13912–14911 | 34 | saveSocialV2State, formatParticipationV2, suggestQuietMsV2, normalizePromiseAt |
| 14912–15911 | 35 | roleRawContent, roleHintForMode, currentRoleHint, roleHintForCurrentMode |
| 15912–16911 | 35 | diaryNudgeTargetKey, diaryNudgeTick, startDiaryNudge, startEmulatorSweep |
| 16912–17911 | 8 | noteConversationStart, takeConversationGlance, handleIncoming, cancelPendingEntry |
| 17912–18228 | 3 | applyHealedTokens, syncTokenToFile, healTokenIfStale |

## 内嵌函数全表

<details><summary>点开（281 个）</summary>

| 行号 | 函数 | 约行数 |
| --- | --- | --- |
| 2955 | `transcribeVoiceSegments` | 55 |
| 3010 | `stickerEnabled` | 4 |
| 3014 | `saveStickerStoreSafe` | 19 |
| 3033 | `photoEnabled` | 3 |
| 3036 | `photoCollectEnabled` | 28 |
| 3064 | `photoRateOk` | 13 |
| 3077 | `saveMediaLibSafe` | 13 |
| 3090 | `captureMessagePhotos` | 53 |
| 3143 | `sendLocalImageV2` | 58 |
| 3201 | `studioOutputsRoot` | 10 |
| 3211 | `resolveStudioOutput` | 27 |
| 3238 | `pickDrawArgs` | 50 |
| 3288 | `drawImageAllowed` | 19 |
| 3307 | `localDay` | 6 |
| 3313 | `drawQuotaOf` | 15 |
| 3328 | `noteDrawUsed` | 10 |
| 3338 | `videoQuotaOf` | 12 |
| 3350 | `noteVideoUsed` | 10 |
| 3360 | `pollDraw` | 16 |
| 3376 | `deliverDraw` | 25 |
| 3401 | `drawImageV2` | 39 |
| 3440 | `sendPhotoV2` | 98 |
| 3538 | `fileDir` | 8 |
| 3546 | `fileDayDir` | 15 |
| 3561 | `uniquePath` | 20 |
| 3581 | `findInDownloads` | 20 |
| 3601 | `fileLimitBytes` | 6 |
| 3607 | `checkFileQuota` | 10 |
| 3617 | `noteFileSend` | 7 |
| 3624 | `guessFileNameFromUrl` | 11 |
| 3635 | `sanitizeFileName` | 10 |
| 3645 | `gatewayUploadFile` | 36 |
| 3681 | `sendFileV2` | 107 |
| 3788 | `applyPhotoNoteV2` | 10 |
| 3798 | `syncStickerLibrary` | 31 |
| 3829 | `listStickersForV2` | 7 |
| 3836 | `getStickerImageData` | 30 |
| 3866 | `assertOutboundAuditOk` | 10 |
| 3876 | `voiceCfg` | 17 |
| 3893 | `voiceLibrary` | 22 |
| 3915 | `voicePathInsideLibrary` | 7 |
| 3922 | `resolveVoicePathForV2` | 76 |
| 3998 | `resolveVoicePathForOperator` | 19 |
| 4017 | `voiceBudgetCheck` | 14 |
| 4031 | `voiceBudgetCommit` | 14 |
| 4045 | `sendVoiceV2` | 91 |
| 4136 | `appendSentVoiceLog` | 15 |
| 4151 | `recordVoiceSentV2` | 30 |
| 4181 | `verifyVoiceMessageSent` | 35 |
| 4216 | `sendVoiceForV2` | 50 |
| 4266 | `speakForV2` | 63 |
| 4329 | `speakOrTextV2` | 78 |
| 4407 | `sendStickerV2` | 77 |
| 4484 | `applyStickerNoteV2` | 13 |
| 4497 | `setStickerRemarkV2` | 21 |
| 4518 | `collectStickerV2` | 46 |
| 4564 | `saveSlangStore` | 14 |
| 4578 | `queueSlangTask` | 5 |
| 4583 | `ensureSlangLearnerSession` | 38 |
| 4621 | `invalidateSlangLearnerSession` | 11 |
| 4632 | `waitLearnerTurn` | 16 |
| 4648 | `runSlangExtraction` | 62 |
| 4710 | `runSlangResearch` | 54 |
| 4764 | `maybeQueueSlangExtraction` | 15 |
| 4779 | `feedSlangWindow` | 14 |
| 4793 | `allowSlangSubmit` | 18 |
| 4811 | `publicSlangEntry` | 16 |
| 4827 | `confirmedSlangListV2` | 9 |
| 4836 | `withSlangContext` | 45 |
| 4881 | `fetchModelCatalog` | 71 |
| 4952 | `rememberModel` | 26 |
| 4978 | `noteCacheAttribution` | 33 |
| 5011 | `recordSessionUsage` | 22 |
| 5033 | `recordSessionSnapshot` | 33 |
| 5066 | `rebuildInFlightCollector` | 35 |
| 5101 | `armPendingWakeLease` | 10 |
| 5111 | `disarmPendingWakeLease` | 5 |
| 5116 | `clearAllPendingWakeLeases` | 43 |
| 5159 | `refreshMode` | 40 |
| 5199 | `refreshPresetList` | 14 |
| 5213 | `modeAllowed` | 19 |
| 5232 | `resolvePresetName` | 15 |
| 5247 | `modePreset` | 13 |
| 5260 | `isSessionAllowedInCurrentMode` | 6 |
| 5266 | `sessionPolicy` | 4 |
| 5270 | `isCurrentSession` | 11 |
| 5281 | `stopRetiredSessionWork` | 18 |
| 5299 | `forgetConversationCaches` | 11 |
| 5310 | `retireSession` | 43 |
| 5353 | `reconcileSessionPolicies` | 161 |
| 5514 | `startDshWatch` | 61 |
| 5575 | `noteUpstreamPacket` | 6 |
| 5581 | `noteReceiveHealth` | 9 |
| 5590 | `snowlumaHealthSnapshot` | 35 |
| 5625 | `reportSnowlumaHealth` | 22 |
| 5647 | `pollSnowlumaStatus` | 26 |
| 5673 | `startSnowlumaWatch` | 23 |
| 5696 | `injectConsoleToken` | 12 |
| 5708 | `v2ToolEnabled` | 17 |
| 5725 | `disabledByOwner` | 53 |
| 5778 | `callSidecarFetch` | 37 |
| 5815 | `endCall` | 22 |
| 5837 | `callRerouteTextIfInCall` | 26 |
| 5863 | `callDeliverTurn` | 72 |
| 5935 | `dropCallWaiter` | 17 |
| 5952 | `bodyDeliverTurn` | 66 |
| 6018 | `resolveCallTurn` | 17 |
| 6035 | `startCallSidecar` | 50 |
| 6085 | `stopCallSidecar` | 47 |
| 6132 | `callOwnerNames` | 9 |
| 6141 | `callFriendNameMap` | 46 |
| 6187 | `callIdentifyCaller` | 19 |
| 6206 | `callWatchTick` | 132 |
| 6338 | `startCallWatch` | 11 |
| 6349 | `startConsoleServer` | 6182 |
| 12531 | `redactKnownTokensOnly` | 13 |
| 12544 | `sendToQQ` | 23 |
| 12567 | `lastSendSucceeded` | 5 |
| 12572 | `singleLineForQQ` | 9 |
| 12581 | `splitLongSegment` | 79 |
| 12660 | `isCjkChar` | 13 |
| 12673 | `splitByCjkSpaces` | 23 |
| 12696 | `planSocialTimeline` | 27 |
| 12723 | `sendBurstToQQ` | 44 |
| 12767 | `onebotSend` | 41 |
| 12808 | `mimeFromBuffer` | 9 |
| 12817 | `mimeFromUrl` | 13 |
| 12830 | `getImageDimensions` | 48 |
| 12878 | `base64FromMaybe` | 33 |
| 12911 | `mediaLimit` | 13 |
| 12924 | `isSafeLocalMediaPath` | 14 |
| 12938 | `isProbablySafeImageFileRef` | 11 |
| 12949 | `fetchOneBotImage` | 74 |
| 13023 | `emojiCdnFallbackEnabled` | 15 |
| 13038 | `emojiCdnCandidates` | 11 |
| 13049 | `emojiIdFromFileName` | 5 |
| 13054 | `fetchFaceMedia` | 54 |
| 13108 | `resolveMediaList` | 42 |
| 13150 | `fetchMediaData` | 55 |
| 13205 | `mediaHintFor` | 8 |
| 13213 | `findMessageMedia` | 30 |
| 13243 | `clampGapV2` | 6 |
| 13249 | `computeGapsV2` | 30 |
| 13279 | `sendMessagesV2` | 49 |
| 13328 | `shouldAuditKey` | 8 |
| 13336 | `captureSendGuard` | 12 |
| 13348 | `shouldBlockSilentReply` | 6 |
| 13354 | `auditAndSend` | 31 |
| 13385 | `ensureChatModel` | 57 |
| 13442 | `ensureSession` | 154 |
| 13596 | `emulatorCfg` | 14 |
| 13610 | `sleepMs` | 5 |
| 13615 | `runEmulatorManager` | 24 |
| 13639 | `emulatorRunning` | 25 |
| 13664 | `normalizeSpeakerIdsV2` | 16 |
| 13680 | `defaultWakeConfigV2` | 36 |
| 13716 | `refreshDefaultWakeConfigV2` | 17 |
| 13733 | `refreshAllDefaultWakeConfigsV2` | 16 |
| 13749 | `hasExplicitEndV2` | 7 |
| 13756 | `isSleepingConfigV2` | 6 |
| 13762 | `preSleepWaitBlockedV2` | 16 |
| 13778 | `computeWakeSafetyV2` | 15 |
| 13793 | `ensureWakeableV2` | 31 |
| 13824 | `deleteConversationKeepingMemory` | 26 |
| 13850 | `getSocialV2State` | 57 |
| 13907 | `loadSocialV2State` | 150 |
| 14057 | `saveSocialV2State` | 51 |
| 14108 | `formatParticipationV2` | 36 |
| 14144 | `suggestQuietMsV2` | 37 |
| 14181 | `normalizePromiseAt` | 7 |
| 14188 | `prunePromises` | 10 |
| 14198 | `formatPromisesV2` | 27 |
| 14225 | `schedulePromiseV2` | 34 |
| 14259 | `formatMemoryV2` | 36 |
| 14295 | `appendMemoryV2` | 104 |
| 14399 | `isSocialEnabled` | 4 |
| 14403 | `socialState` | 8 |
| 14411 | `isDirectAddress` | 14 |
| 14425 | `isDirectedAtAi` | 17 |
| 14442 | `isMustReplyText` | 10 |
| 14452 | `appendRecentMessage` | 18 |
| 14470 | `appendSummary` | 9 |
| 14479 | `buildContextBlock` | 6 |
| 14485 | `enterActive` | 21 |
| 14506 | `cancelSocialTimers` | 7 |
| 14513 | `cancelAllSocialTimers` | 8 |
| 14521 | `cleanupSocialForModeChange` | 16 |
| 14537 | `leaveActive` | 8 |
| 14545 | `buildBatchPrompt` | 10 |
| 14555 | `buildProbePrompt` | 6 |
| 14561 | `buildActiveExitPrompt` | 9 |
| 14570 | `triggerActiveDurationExit` | 25 |
| 14595 | `buildProactivePrompt` | 8 |
| 14603 | `deliverPromptNow` | 124 |
| 14727 | `deliverPrompt` | 12 |
| 14739 | `processPromptQueue` | 23 |
| 14762 | `scheduleSocialReply` | 17 |
| 14779 | `socialLoopTick` | 118 |
| 14897 | `startSocialLoop` | 6 |
| 14903 | `flushSummaries` | 56 |
| 14959 | `roleRawContent` | 32 |
| 14991 | `roleHintForMode` | 5 |
| 14996 | `currentRoleHint` | 9 |
| 15005 | `roleHintForCurrentMode` | 7 |
| 15012 | `isCjkLikeChar` | 14 |
| 15026 | `convertExampleSpacesToComma` | 25 |
| 15051 | `findCjkSpaceWarning` | 24 |
| 15075 | `findSplitBoundaryWarning` | 21 |
| 15096 | `currentRoleHintV2` | 33 |
| 15129 | `pruneGroupMemberNameCache` | 15 |
| 15144 | `assertGroupMember` | 26 |
| 15170 | `resolveGroupMemberName` | 36 |
| 15206 | `pruneReplyInfoCache` | 11 |
| 15217 | `resolveReplyInfo` | 67 |
| 15284 | `resolveReplyTargetV2` | 39 |
| 15323 | `isQuoteTargetSelf` | 12 |
| 15335 | `appendSocialV2Message` | 77 |
| 15412 | `appendSocialV2Poke` | 50 |
| 15462 | `recordSentMessagesV2` | 26 |
| 15488 | `readFeedbackEntries` | 5 |
| 15493 | `appendFeedbackEntry` | 11 |
| 15504 | `readToolLog` | 16 |
| 15520 | `appendToolLog` | 32 |
| 15552 | `redactSensitive` | 16 |
| 15568 | `sanitizeToolArgs` | 21 |
| 15589 | `evaluateWakeTriggerV2` | 39 |
| 15628 | `readThroughSeqV2` | 16 |
| 15644 | `noteModelMessagesV2` | 10 |
| 15654 | `requestedReadThroughSeqV2` | 12 |
| 15666 | `acknowledgeMessagesV2` | 14 |
| 15680 | `buildWakeSnapshotV2` | 38 |
| 15718 | `replyTimingV2` | 22 |
| 15740 | `selfIdentityTextV2` | 25 |
| 15765 | `recallForPrompt` | 53 |
| 15818 | `buildWakePromptV2` | 176 |
| 15994 | `diaryNudgeTargetKey` | 13 |
| 16007 | `diaryNudgeTick` | 55 |
| 16062 | `startDiaryNudge` | 17 |
| 16079 | `startEmulatorSweep` | 23 |
| 16102 | `dailyOutfitTick` | 18 |
| 16120 | `startDailyOutfit` | 8 |
| 16128 | `buildWakeReminderPromptV2` | 11 |
| 16139 | `sendWakePromptV2` | 111 |
| 16250 | `cancelReplyCheckV2` | 7 |
| 16257 | `scheduleReplyCheckV2` | 26 |
| 16283 | `isTurnStaleV2` | 10 |
| 16293 | `reapStaleTurnV2` | 32 |
| 16325 | `startV2TurnWatchdog` | 15 |
| 16340 | `isConversationBusyV2` | 44 |
| 16384 | `isAutonomousWakeReason` | 43 |
| 16427 | `quietGrantMs` | 23 |
| 16450 | `qzoneWriteMinGapMs` | 10 |
| 16460 | `qzoneWriteGapCheck` | 11 |
| 16471 | `qzoneWriteMark` | 12 |
| 16483 | `scheduleQuietAutonomy` | 39 |
| 16522 | `cancelQuietAutonomy` | 20 |
| 16542 | `isAutonomousTurnActive` | 21 |
| 16563 | `wakePriorityV2` | 30 |
| 16593 | `scheduleWakeV2` | 74 |
| 16667 | `canSteerV2` | 19 |
| 16686 | `steerIntoRunningTurnV2` | 27 |
| 16713 | `setupSleepTimerV2` | 38 |
| 16751 | `cancelProactiveCheckV2` | 7 |
| 16758 | `scheduleProactiveCheckV2` | 55 |
| 16813 | `clearSocialV2Timers` | 27 |
| 16840 | `clearAllSocialV2Timers` | 9 |
| 16849 | `drainPromptQueue` | 8 |
| 16857 | `drainAllPromptQueues` | 27 |
| 16884 | `convGlanceGapMs` | 7 |
| 16891 | `captureBodyPhotoForGlance` | 41 |
| 16932 | `noteConversationStart` | 14 |
| 16946 | `takeConversationGlance` | 14 |
| 16960 | `handleIncoming` | 375 |
| 17335 | `cancelPendingEntry` | 25 |
| 17360 | `handlePendingAnswer` | 56 |
| 17416 | `handlePokeNotice` | 60 |
| 17476 | `registerPending` | 20 |
| 17496 | `pumpMux` | 606 |
| 18102 | `applyHealedTokens` | 55 |
| 18157 | `syncTokenToFile` | 8 |
| 18165 | `healTokenIfStale` | 114 |

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