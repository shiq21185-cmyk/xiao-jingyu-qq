# bridge.js 结构地图

> 自动生成于 2026/11/10 13:33:57。**改代码前先查这里**，别通读全文。
> 重新生成：`node scripts/mapgen.mjs`（或 `npm run map`）

## 规模

- 总行数：**18382**
- 顶层函数：**85** 个
- `main()` 内嵌函数：**281** 个
- `main()` 占 **15400 行（84%）** —— 这就是"文件太大"的主体

## 文件分区

| 行段 | 内容 |
| --- | --- |
| 1–95 | import + 常量 |
| 96–2932 | 顶层工具函数（JSON 读写、角色卡、preset、日志、脱敏…） |
| **2933–18332** | **`main()` 主体（84%）** |
| 18333–18382 | 启动：`main().catch(...)` + 进程级钩子 |

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
| 1024 | `pickRecallRows` | 136 |
| 1160 | `renderRecallBlock` | 24 |
| 1184 | `readConfigObject` | 14 |
| 1198 | `renameWithRetry` | 17 |
| 1215 | `atomicWriteJson` | 14 |
| 1229 | `atomicWriteText` | 13 |
| 1242 | `loadOrCreateConsoleToken` | 31 |
| 1273 | `hardenStateDirAcl` | 17 |
| 1290 | `readActivityTail` | 10 |
| 1300 | `listRoles` | 22 |
| 1322 | `applyRoleInjectLimit` | 14 |
| 1336 | `applyImpressionTraitChars` | 5 |
| 1341 | `impressionTraitMaxChars` | 12 |
| 1353 | `roleFilePath` | 4 |
| 1357 | `firstMeaningfulLine` | 8 |
| 1365 | `roleWarnings` | 22 |
| 1387 | `roleSummaries` | 29 |
| 1416 | `validateRoleName` | 9 |
| 1425 | `validateRoleContent` | 10 |
| 1435 | `readRoleContent` | 4 |
| 1439 | `writeRoleContent` | 17 |
| 1456 | `presetSourceYaml` | 4 |
| 1460 | `dshHomeDir` | 4 |
| 1464 | `installedPresetYaml` | 11 |
| 1475 | `readPresetPromptText` | 11 |
| 1486 | `presetBackupPrefix` | 4 |
| 1490 | `backupPresetFile` | 15 |
| 1505 | `listPresetBackups` | 12 |
| 1517 | `presetStatus` | 17 |
| 1534 | `isSilentMarker` | 7 |
| 1541 | `isSendToolName` | 33 |
| 1574 | `rememberAgentToken` | 21 |
| 1595 | `forgetAgentToken` | 18 |
| 1613 | `normalizeReasoningEffort` | 10 |
| 1623 | `redactSensitiveText` | 13 |
| 1636 | `escapeCqText` | 5 |
| 1641 | `unquoteJsonString` | 14 |
| 1655 | `appendActivity` | 6 |
| 1661 | `readRoleState` | 3 |
| 1664 | `writeRoleState` | 3 |
| 1667 | `sanitizeRoleName` | 5 |
| 1672 | `normalizeOwnerQQ` | 11 |
| 1683 | `normalizeIdList` | 14 |
| 1697 | `decodeShellOutput` | 60 |
| 1757 | `runPowerShellEncoded` | 20 |
| 1777 | `runProcessEncoded` | 124 |
| 1901 | `wrapInputScript` | 20 |
| 1921 | `parseFgMarks` | 32 |
| 1953 | `VK_EXPR` | 13 |
| 1966 | `loadConfig` | 580 |
| 2546 | `loadState` | 28 |
| 2574 | `saveState` | 21 |
| 2595 | `consolePortInUse` | 16 |
| 2611 | `acquireLock` | 63 |
| 2674 | `releaseLock` | 23 |
| 2697 | `createCappedLogger` | 29 |
| 2726 | `localClock` | 8 |
| 2734 | `log` | 19 |
| 2753 | `withTimeout` | 13 |
| 2766 | `describeJsonCard` | 37 |
| 2803 | `segmentsToText` | 66 |
| 2869 | `extractMediaFromSegments` | 26 |
| 2895 | `allowed` | 12 |
| 2907 | `canonicalV2Key` | 26 |
| 2933 | `main` | 15450 |

## `main()` 内部密度

（每 1000 行有几个内嵌函数；密度高的地方是功能密集区，改之前多读几行）

| 行段 | 内嵌函数 | 代表 |
| --- | --- | --- |
| 2933–3932 | 40 | transcribeVoiceSegments, stickerEnabled, saveStickerStoreSafe, photoEnabled |
| 3933–4932 | 30 | voicePathInsideLibrary, resolveVoicePathForV2, resolveVoicePathForOperator, voiceBudgetCheck |
| 4933–5932 | 34 | rememberModel, noteCacheAttribution, recordSessionUsage, recordSessionSnapshot |
| 5933–6932 | 11 | dropCallWaiter, bodyDeliverTurn, resolveCallTurn, startCallSidecar |
| 6933–7932 | 0 | — |
| 7933–8932 | 0 | — |
| 8933–9932 | 0 | — |
| 9933–10932 | 0 | — |
| 10933–11932 | 0 | — |
| 11933–12932 | 13 | redactKnownTokensOnly, sendToQQ, lastSendSucceeded, singleLineForQQ |
| 12933–13932 | 37 | base64FromMaybe, mediaLimit, isSafeLocalMediaPath, isProbablySafeImageFileRef |
| 13933–14932 | 33 | loadSocialV2State, saveSocialV2State, formatParticipationV2, suggestQuietMsV2 |
| 14933–15932 | 37 | startSocialLoop, flushSummaries, roleRawContent, roleHintForMode |
| 15933–16932 | 30 | diaryNudgeTargetKey, diaryNudgeTick, startDiaryNudge, startEmulatorSweep |
| 16933–17932 | 13 | clearAllSocialV2Timers, drainPromptQueue, drainAllPromptQueues, convGlanceGapMs |
| 17933–18332 | 3 | applyHealedTokens, syncTokenToFile, healTokenIfStale |

## 内嵌函数全表

<details><summary>点开（281 个）</summary>

| 行号 | 函数 | 约行数 |
| --- | --- | --- |
| 2976 | `transcribeVoiceSegments` | 55 |
| 3031 | `stickerEnabled` | 4 |
| 3035 | `saveStickerStoreSafe` | 19 |
| 3054 | `photoEnabled` | 3 |
| 3057 | `photoCollectEnabled` | 28 |
| 3085 | `photoRateOk` | 13 |
| 3098 | `saveMediaLibSafe` | 13 |
| 3111 | `captureMessagePhotos` | 53 |
| 3164 | `sendLocalImageV2` | 58 |
| 3222 | `studioOutputsRoot` | 10 |
| 3232 | `resolveStudioOutput` | 27 |
| 3259 | `pickDrawArgs` | 50 |
| 3309 | `drawImageAllowed` | 19 |
| 3328 | `localDay` | 6 |
| 3334 | `drawQuotaOf` | 15 |
| 3349 | `noteDrawUsed` | 10 |
| 3359 | `videoQuotaOf` | 12 |
| 3371 | `noteVideoUsed` | 10 |
| 3381 | `pollDraw` | 16 |
| 3397 | `deliverDraw` | 25 |
| 3422 | `drawImageV2` | 39 |
| 3461 | `sendPhotoV2` | 98 |
| 3559 | `fileDir` | 8 |
| 3567 | `fileDayDir` | 15 |
| 3582 | `uniquePath` | 20 |
| 3602 | `findInDownloads` | 20 |
| 3622 | `fileLimitBytes` | 6 |
| 3628 | `checkFileQuota` | 10 |
| 3638 | `noteFileSend` | 7 |
| 3645 | `guessFileNameFromUrl` | 11 |
| 3656 | `sanitizeFileName` | 10 |
| 3666 | `gatewayUploadFile` | 36 |
| 3702 | `sendFileV2` | 107 |
| 3809 | `applyPhotoNoteV2` | 10 |
| 3819 | `syncStickerLibrary` | 31 |
| 3850 | `listStickersForV2` | 7 |
| 3857 | `getStickerImageData` | 30 |
| 3887 | `assertOutboundAuditOk` | 10 |
| 3897 | `voiceCfg` | 17 |
| 3914 | `voiceLibrary` | 22 |
| 3936 | `voicePathInsideLibrary` | 7 |
| 3943 | `resolveVoicePathForV2` | 76 |
| 4019 | `resolveVoicePathForOperator` | 19 |
| 4038 | `voiceBudgetCheck` | 14 |
| 4052 | `voiceBudgetCommit` | 14 |
| 4066 | `sendVoiceV2` | 91 |
| 4157 | `appendSentVoiceLog` | 15 |
| 4172 | `recordVoiceSentV2` | 30 |
| 4202 | `verifyVoiceMessageSent` | 35 |
| 4237 | `sendVoiceForV2` | 50 |
| 4287 | `speakForV2` | 63 |
| 4350 | `speakOrTextV2` | 78 |
| 4428 | `sendStickerV2` | 77 |
| 4505 | `applyStickerNoteV2` | 13 |
| 4518 | `setStickerRemarkV2` | 21 |
| 4539 | `collectStickerV2` | 46 |
| 4585 | `saveSlangStore` | 14 |
| 4599 | `queueSlangTask` | 5 |
| 4604 | `ensureSlangLearnerSession` | 38 |
| 4642 | `invalidateSlangLearnerSession` | 11 |
| 4653 | `waitLearnerTurn` | 16 |
| 4669 | `runSlangExtraction` | 62 |
| 4731 | `runSlangResearch` | 54 |
| 4785 | `maybeQueueSlangExtraction` | 15 |
| 4800 | `feedSlangWindow` | 14 |
| 4814 | `allowSlangSubmit` | 18 |
| 4832 | `publicSlangEntry` | 16 |
| 4848 | `confirmedSlangListV2` | 9 |
| 4857 | `withSlangContext` | 45 |
| 4902 | `fetchModelCatalog` | 71 |
| 4973 | `rememberModel` | 26 |
| 4999 | `noteCacheAttribution` | 33 |
| 5032 | `recordSessionUsage` | 22 |
| 5054 | `recordSessionSnapshot` | 33 |
| 5087 | `rebuildInFlightCollector` | 35 |
| 5122 | `armPendingWakeLease` | 10 |
| 5132 | `disarmPendingWakeLease` | 5 |
| 5137 | `clearAllPendingWakeLeases` | 43 |
| 5180 | `refreshMode` | 40 |
| 5220 | `refreshPresetList` | 14 |
| 5234 | `modeAllowed` | 19 |
| 5253 | `resolvePresetName` | 15 |
| 5268 | `modePreset` | 24 |
| 5292 | `isSessionAllowedInCurrentMode` | 6 |
| 5298 | `sessionPolicy` | 4 |
| 5302 | `isCurrentSession` | 11 |
| 5313 | `stopRetiredSessionWork` | 18 |
| 5331 | `forgetConversationCaches` | 11 |
| 5342 | `retireSession` | 44 |
| 5386 | `reconcileSessionPolicies` | 161 |
| 5547 | `startDshWatch` | 61 |
| 5608 | `noteUpstreamPacket` | 6 |
| 5614 | `noteReceiveHealth` | 9 |
| 5623 | `snowlumaHealthSnapshot` | 35 |
| 5658 | `reportSnowlumaHealth` | 22 |
| 5680 | `pollSnowlumaStatus` | 26 |
| 5706 | `startSnowlumaWatch` | 23 |
| 5729 | `injectConsoleToken` | 12 |
| 5741 | `v2ToolEnabled` | 17 |
| 5758 | `disabledByOwner` | 53 |
| 5811 | `callSidecarFetch` | 37 |
| 5848 | `endCall` | 22 |
| 5870 | `callRerouteTextIfInCall` | 26 |
| 5896 | `callDeliverTurn` | 72 |
| 5968 | `dropCallWaiter` | 17 |
| 5985 | `bodyDeliverTurn` | 66 |
| 6051 | `resolveCallTurn` | 17 |
| 6068 | `startCallSidecar` | 50 |
| 6118 | `stopCallSidecar` | 47 |
| 6165 | `callOwnerNames` | 9 |
| 6174 | `callFriendNameMap` | 46 |
| 6220 | `callIdentifyCaller` | 19 |
| 6239 | `callWatchTick` | 132 |
| 6371 | `startCallWatch` | 11 |
| 6382 | `startConsoleServer` | 6219 |
| 12601 | `redactKnownTokensOnly` | 13 |
| 12614 | `sendToQQ` | 23 |
| 12637 | `lastSendSucceeded` | 5 |
| 12642 | `singleLineForQQ` | 9 |
| 12651 | `splitLongSegment` | 79 |
| 12730 | `isCjkChar` | 13 |
| 12743 | `splitByCjkSpaces` | 23 |
| 12766 | `planSocialTimeline` | 27 |
| 12793 | `sendBurstToQQ` | 44 |
| 12837 | `onebotSend` | 41 |
| 12878 | `mimeFromBuffer` | 9 |
| 12887 | `mimeFromUrl` | 13 |
| 12900 | `getImageDimensions` | 48 |
| 12948 | `base64FromMaybe` | 33 |
| 12981 | `mediaLimit` | 13 |
| 12994 | `isSafeLocalMediaPath` | 14 |
| 13008 | `isProbablySafeImageFileRef` | 11 |
| 13019 | `fetchOneBotImage` | 74 |
| 13093 | `emojiCdnFallbackEnabled` | 15 |
| 13108 | `emojiCdnCandidates` | 11 |
| 13119 | `emojiIdFromFileName` | 5 |
| 13124 | `fetchFaceMedia` | 54 |
| 13178 | `resolveMediaList` | 42 |
| 13220 | `fetchMediaData` | 55 |
| 13275 | `mediaHintFor` | 8 |
| 13283 | `findMessageMedia` | 30 |
| 13313 | `clampGapV2` | 6 |
| 13319 | `computeGapsV2` | 30 |
| 13349 | `sendMessagesV2` | 49 |
| 13398 | `shouldAuditKey` | 8 |
| 13406 | `captureSendGuard` | 12 |
| 13418 | `shouldBlockSilentReply` | 6 |
| 13424 | `auditAndSend` | 31 |
| 13455 | `ensureChatModel` | 57 |
| 13512 | `ensureSession` | 160 |
| 13672 | `emulatorCfg` | 14 |
| 13686 | `sleepMs` | 5 |
| 13691 | `runEmulatorManager` | 24 |
| 13715 | `emulatorRunning` | 25 |
| 13740 | `normalizeSpeakerIdsV2` | 16 |
| 13756 | `defaultWakeConfigV2` | 36 |
| 13792 | `refreshDefaultWakeConfigV2` | 17 |
| 13809 | `refreshAllDefaultWakeConfigsV2` | 16 |
| 13825 | `hasExplicitEndV2` | 7 |
| 13832 | `isSleepingConfigV2` | 6 |
| 13838 | `preSleepWaitBlockedV2` | 16 |
| 13854 | `computeWakeSafetyV2` | 15 |
| 13869 | `ensureWakeableV2` | 31 |
| 13900 | `deleteConversationKeepingMemory` | 26 |
| 13926 | `getSocialV2State` | 58 |
| 13984 | `loadSocialV2State` | 151 |
| 14135 | `saveSocialV2State` | 52 |
| 14187 | `formatParticipationV2` | 36 |
| 14223 | `suggestQuietMsV2` | 37 |
| 14260 | `normalizePromiseAt` | 7 |
| 14267 | `prunePromises` | 10 |
| 14277 | `formatPromisesV2` | 27 |
| 14304 | `schedulePromiseV2` | 34 |
| 14338 | `formatMemoryV2` | 36 |
| 14374 | `appendMemoryV2` | 104 |
| 14478 | `isSocialEnabled` | 4 |
| 14482 | `socialState` | 8 |
| 14490 | `isDirectAddress` | 14 |
| 14504 | `isDirectedAtAi` | 17 |
| 14521 | `isMustReplyText` | 10 |
| 14531 | `appendRecentMessage` | 18 |
| 14549 | `appendSummary` | 9 |
| 14558 | `buildContextBlock` | 6 |
| 14564 | `enterActive` | 21 |
| 14585 | `cancelSocialTimers` | 7 |
| 14592 | `cancelAllSocialTimers` | 8 |
| 14600 | `cleanupSocialForModeChange` | 16 |
| 14616 | `leaveActive` | 8 |
| 14624 | `buildBatchPrompt` | 10 |
| 14634 | `buildProbePrompt` | 6 |
| 14640 | `buildActiveExitPrompt` | 9 |
| 14649 | `triggerActiveDurationExit` | 25 |
| 14674 | `buildProactivePrompt` | 8 |
| 14682 | `deliverPromptNow` | 130 |
| 14812 | `deliverPrompt` | 12 |
| 14824 | `processPromptQueue` | 23 |
| 14847 | `scheduleSocialReply` | 17 |
| 14864 | `socialLoopTick` | 118 |
| 14982 | `startSocialLoop` | 6 |
| 14988 | `flushSummaries` | 56 |
| 15044 | `roleRawContent` | 32 |
| 15076 | `roleHintForMode` | 5 |
| 15081 | `currentRoleHint` | 9 |
| 15090 | `roleHintForCurrentMode` | 7 |
| 15097 | `isCjkLikeChar` | 14 |
| 15111 | `convertExampleSpacesToComma` | 25 |
| 15136 | `findCjkSpaceWarning` | 24 |
| 15160 | `findSplitBoundaryWarning` | 21 |
| 15181 | `currentRoleHintV2` | 33 |
| 15214 | `pruneGroupMemberNameCache` | 15 |
| 15229 | `assertGroupMember` | 26 |
| 15255 | `resolveGroupMemberName` | 36 |
| 15291 | `pruneReplyInfoCache` | 11 |
| 15302 | `resolveReplyInfo` | 67 |
| 15369 | `resolveReplyTargetV2` | 39 |
| 15408 | `isQuoteTargetSelf` | 12 |
| 15420 | `appendSocialV2Message` | 77 |
| 15497 | `appendSocialV2Poke` | 50 |
| 15547 | `recordSentMessagesV2` | 26 |
| 15573 | `readFeedbackEntries` | 5 |
| 15578 | `appendFeedbackEntry` | 11 |
| 15589 | `readToolLog` | 16 |
| 15605 | `appendToolLog` | 32 |
| 15637 | `redactSensitive` | 16 |
| 15653 | `sanitizeToolArgs` | 21 |
| 15674 | `evaluateWakeTriggerV2` | 39 |
| 15713 | `readThroughSeqV2` | 16 |
| 15729 | `noteModelMessagesV2` | 10 |
| 15739 | `requestedReadThroughSeqV2` | 12 |
| 15751 | `acknowledgeMessagesV2` | 14 |
| 15765 | `buildWakeSnapshotV2` | 38 |
| 15803 | `replyTimingV2` | 22 |
| 15825 | `selfIdentityTextV2` | 25 |
| 15850 | `recallForPrompt` | 53 |
| 15903 | `buildWakePromptV2` | 192 |
| 16095 | `diaryNudgeTargetKey` | 13 |
| 16108 | `diaryNudgeTick` | 55 |
| 16163 | `startDiaryNudge` | 17 |
| 16180 | `startEmulatorSweep` | 23 |
| 16203 | `dailyOutfitTick` | 18 |
| 16221 | `startDailyOutfit` | 8 |
| 16229 | `buildWakeReminderPromptV2` | 11 |
| 16240 | `sendWakePromptV2` | 114 |
| 16354 | `cancelReplyCheckV2` | 7 |
| 16361 | `scheduleReplyCheckV2` | 26 |
| 16387 | `isTurnStaleV2` | 10 |
| 16397 | `reapStaleTurnV2` | 32 |
| 16429 | `startV2TurnWatchdog` | 15 |
| 16444 | `isConversationBusyV2` | 44 |
| 16488 | `isAutonomousWakeReason` | 43 |
| 16531 | `quietGrantMs` | 23 |
| 16554 | `qzoneWriteMinGapMs` | 10 |
| 16564 | `qzoneWriteGapCheck` | 11 |
| 16575 | `qzoneWriteMark` | 12 |
| 16587 | `scheduleQuietAutonomy` | 39 |
| 16626 | `cancelQuietAutonomy` | 20 |
| 16646 | `isAutonomousTurnActive` | 21 |
| 16667 | `wakePriorityV2` | 30 |
| 16697 | `scheduleWakeV2` | 74 |
| 16771 | `canSteerV2` | 19 |
| 16790 | `steerIntoRunningTurnV2` | 27 |
| 16817 | `setupSleepTimerV2` | 38 |
| 16855 | `cancelProactiveCheckV2` | 7 |
| 16862 | `scheduleProactiveCheckV2` | 55 |
| 16917 | `clearSocialV2Timers` | 27 |
| 16944 | `clearAllSocialV2Timers` | 9 |
| 16953 | `drainPromptQueue` | 8 |
| 16961 | `drainAllPromptQueues` | 27 |
| 16988 | `convGlanceGapMs` | 7 |
| 16995 | `captureBodyPhotoForGlance` | 41 |
| 17036 | `noteConversationStart` | 14 |
| 17050 | `takeConversationGlance` | 14 |
| 17064 | `handleIncoming` | 375 |
| 17439 | `cancelPendingEntry` | 25 |
| 17464 | `handlePendingAnswer` | 56 |
| 17520 | `handlePokeNotice` | 60 |
| 17580 | `registerPending` | 20 |
| 17600 | `pumpMux` | 606 |
| 18206 | `applyHealedTokens` | 55 |
| 18261 | `syncTokenToFile` | 8 |
| 18269 | `healTokenIfStale` | 114 |

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