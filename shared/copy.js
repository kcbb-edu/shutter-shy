export const APP_TITLE = "Shutter Shy 快門追追追";

export const COPY = {
  common: {
    guest: "訪客",
    player: "玩家",
    noRole: "尚未選擇",
    ready: "準備好",
    cancelReady: "取消準備",
    online: "連線中",
    offline: "離線",
    reconnecting: "重新連線中…"
  },
  roles: {
    photographer: "攝影師",
    runner: "跑者"
  },
  themes: {
    random: "隨機",
    randomEachRound: "每回合隨機",
    neon: "霓虹",
    synthwave: "彩虹樂園"
  },
  controller: {
    namePlaceholderSuffix: "（或自行輸入）",
    enablePermissionsToContinue: "開啟以上權限後繼續",
    readyFinished: "準備好了！",
    shutterReady: "可拍照",
    roomConnected: "已連上房間。",
    roomJoinHint: "輸入大螢幕上的房號，或直接使用建議名字。",
    photographerTaken: "攝影師已經有人選了，請改選跑者。",
    chooseRole: "選擇這回合要玩的角色。",
    enoughPlayers: "人數已足夠，完成設定後準備開始。",
    needMorePlayers(runnerSlotsRemaining) {
      return `還需要 1 位攝影師和 1 位跑者，剩餘 ${runnerSlotsRemaining} 個跑者名額。`;
    },
    permissionsTitlePhotographer: "啟用動作感應",
    permissionsTitleRunner: "啟用臉部相機",
    permissionsCopyPhotographer: "開啟動作感應後，就能在這裡按下準備。",
    permissionsCopyRunner: "如果想把你的臉套用到角色上，可以開啟臉部照片。",
    faceDetectedReady: "已偵測到臉部，可以準備了。",
    faceKeepVisible: "請讓臉保持在畫面內，才能準備。",
    faceOptionalOff: "未開啟臉部照片，也可以直接準備。",
    faceTrackingLive: "臉部辨識中。",
    faceCameraStarting: "相機啟動中…",
    faceCameraEnabled: "相機已開啟，請讓臉出現在畫面內。",
    faceOptionalHint: "想把臉套用到角色上時，再開啟這個選項。",
    motionReady: "已開啟動作感應，可以準備了。",
    motionRequired: "請先開啟動作感應，才能準備。",
    countdown: "倒數結束後就會開始。",
    runnerPhase: "沿著跑道移動，別被鏡頭拍到。",
    photographerPhase: "按下快門拍照，結果會在回合結束後公布。",
    waitingForOthers(seconds) {
      return `這支手機已關閉相簿，等待其他玩家中… ${seconds} 秒`;
    },
    capturedSummary(capturedCount, totalRunners) {
      return `${capturedCount}/${totalRunners} 位跑者被拍到。長按照片即可儲存。`;
    },
    noRunnerSummary: "本回合沒有跑者結果。",
    noSuccessfulCaptures: "這回合還沒有拍照紀錄。",
    successfulPhotoAlt: "拍到的照片",
    missedPhotoAlt: "沒拍到的照片",
    noPreview: "沒有預覽圖",
    capturedCount(runnerCount) {
      return `${runnerCount} 位跑者`;
    },
    blockedCount(runnerCount) {
      return `被擋住 ${runnerCount} 位`;
    },
    shotHit: "拍到了",
    shotMiss: "沒拍到",
    summaryCaptured: "拍到了",
    summaryEscaped: "逃掉了",
    permissionPlayersEmpty: "等待其他裝置加入。",
    setupMotionReady: "動作感應已開啟",
    setupNeedMotion: "需要動作感應",
    setupFaceReady: "臉部已就緒",
    setupNeedFace: "需要拍到臉部",
    setupFaceOff: "未開啟臉部照片",
    setupChooseRole: "請先選角色",
    themeModeManual(themeLabel) {
      return `指定風格：${themeLabel}`;
    },
    themeUpdating: "正在更新場景風格…",
    themePickRoleFirst: "請先選擇攝影師，再設定場景風格。",
    themeCurrent(themeLabel) {
      return `本回合風格：${themeLabel}`;
    },
    themePreviewAtRoundStart(themeLabel) {
      return `回合開始時會決定風格，目前預覽為「${themeLabel}」。`;
    },
    themePreviewNextRound(themeLabel) {
      return `下一回合會使用「${themeLabel}」。`;
    }
  },
  display: {
    playersEmpty: "等待玩家加入。",
    runnerSummaryEmpty: "還沒有跑者結果。",
    scoreCopy(capturedCount, totalRunners) {
      return `${capturedCount}/${totalRunners} 位跑者至少被拍到 1 次。`;
    },
    reviewingResults: "正在查看本回合結果。",
    closeGalleryProgress(closedCount, totalCount) {
      return `關閉相簿後繼續… ${closedCount}/${totalCount} 已完成`;
    },
    playingPhase: "攝影師正在拍照，噴水可能會擋住鏡頭。",
    lobbyPhase: "掃描 QR Code、選擇角色、準備開始。",
    successfulPhotos(photoCount) {
      return `${photoCount} 張成功照片`;
    },
    noSuccessfulPhotos: "沒有成功照片"
  },
  results: {
    photographerWin: "攝影師獲勝！",
    runnersWin: "跑者獲勝！"
  },
  roomClosed: {
    displayDisconnected: "大螢幕已中斷連線，房間已關閉。",
    displayNewRoomWithCode(roomCode) {
      return `大螢幕已開新房間（${roomCode}），請用新房號重新加入。`;
    },
    displayNewRoom: "大螢幕已開新房間，請用新房號重新加入。",
    unavailable: "房間目前無法使用。"
  },
  errors: {
    roomFull: "房間已滿。",
    invalidRoomCode: "請輸入正確的房號。",
    missingSessionId: "缺少連線資料。",
    roomNotFound: "找不到這個房間。",
    playerNotFound: "找不到玩家資料。",
    onlyPhotographerCanSetTheme: "只有攝影師可以設定場景風格。",
    themeLocked: "本回合的場景風格已鎖定。",
    unknownTheme: "找不到這個場景風格。",
    unknownRole: "找不到這個角色。",
    photographerTaken: "攝影師已經有人選了。",
    chooseRoleFirst: "請先選擇角色。",
    runnerNeedsFace: "跑者要先拍到臉，才能準備。",
    photographerNeedsMotion: "攝影師要先開啟動作感應。",
    assetsNotReady: "遊戲還沒準備好。",
    invalidFaceImage: "臉部照片無效。",
    onlyPhotographerCanShoot: "只有攝影師可以拍照。",
    roundNotActive: "目前還不能拍照。",
    shutterCoolingDown: "快門冷卻中。",
    photoTooLarge: "照片檔案太大。",
    motionPermissionDenied: "沒有取得動作感應權限。",
    motionAccessFailed: "無法啟用動作感應。",
    faceCameraStartFailed: "無法啟動相機。",
    faceDetectionFailed: "臉部辨識失敗。",
    faceCameraFailed: "相機發生錯誤。"
  }
};

export function formatRoleLabel(role) {
  if (role === "photographer") {
    return COPY.roles.photographer;
  }
  if (role === "runner") {
    return COPY.roles.runner;
  }
  return COPY.common.noRole;
}

export function formatThemeLabel(themeId) {
  if (themeId === "synthwave") {
    return COPY.themes.synthwave;
  }
  if (themeId === "neon") {
    return COPY.themes.neon;
  }
  return COPY.themes.random;
}

export function formatWinnerTitle(winner) {
  return winner === "photographer" ? COPY.results.photographerWin : COPY.results.runnersWin;
}

export function getRoomClosedMessage(reason, replacementRoomCode) {
  if (reason === "display-disconnected") {
    return COPY.roomClosed.displayDisconnected;
  }
  if (reason === "display-new-room") {
    return replacementRoomCode
      ? COPY.roomClosed.displayNewRoomWithCode(replacementRoomCode)
      : COPY.roomClosed.displayNewRoom;
  }
  return COPY.roomClosed.unavailable;
}
