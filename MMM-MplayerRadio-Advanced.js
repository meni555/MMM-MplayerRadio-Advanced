/* global Module

/* MagicMirror²
 * Module: MplayerRadio-Advanced (fork of MMM-MplayerRadio)
 *
 * By Tom Hirschberger
 * MIT Licensed.
 */
Module.register('MMM-MplayerRadio-Advanced', {

  /**
   * By default, we should try to make the configuration match the demo
   * implementation. This means 3 pages, and some default enabled styles.
   */
  defaults: {
    mplayerPath: "/usr/bin/mplayer",
    mplayerCache: 512,
    changeStationOnProfileChange: true,
    showControls: true,
    showVolControls: true,
    showStreamInfo: true,
    showStations: true,
    showLogos: true,
    showTitles: true,
    scrollableStations: false,
    stationsBeforeAndAfter: 1,
    scrollToActiveStation: true,
    missingLogoUrl: "./MMM-MplayerRadio-Advanced/radio-freepnglogos.png",
    previousIcon: "ic-round-skip-previous",
    playIcon: "ic-round-play-arrow",
    stopIcon: "ic-round-stop",
    pauseIcon: "ic-round-pause",
    nextIcon: "ic-round-skip-next",
    volUpIcon: "bi-volume-up-fill",
    volDownIcon: "bi-volume-down-fill",
    animationSpeed: 500,
    customCommand: null,
    customCommandArgs: [],
    autoplay: null,
    initStation: null,
    stopOnSuspend: false,
    // External sources (Spotify Connect via Soloist / YouTube Music cast) as carousel entries
    externalSources: ["youtube", "spotify"],
    showExternalWhenIdle: true,
    externalNames: { youtube: "YouTube Music", spotify: "Spotify" },
    externalIcons: { youtube: "simple-icons:youtubemusic", spotify: "simple-icons:spotify" },
    externalControl: { youtube: "http://127.0.0.1:8099", spotify: "http://127.0.0.1:3678" },
  },

  /**
   * Apply any styles, if we have any.
   */
  getStyles() {
    if (this.config.scrollableStations){
      return ['mplayer-radio.css', 'mplayer-radio-scroll.css', 'mplayer-radio-external.css'];
    } else {
      return ['mplayer-radio.css', 'mplayer-radio-external.css'];
    }
  },

  // ---------- external sources ----------
  // The carousel shows radio stations (numeric ids, = index in config.stations) followed by
  // external sources ("ext:youtube", "ext:spotify"). While an external source plays it is selected.
  displayKey() {
    return this.external ? "ext:" + this.external.source : this.curStationIndex
  },

  externalPaths: {
    youtube: { pause: "/pause", resume: "/resume", next: "/next", previous: "/previous", stop: "/stop" },
    spotify: { pause: "/player/pause", resume: "/player/resume", next: "/player/next", previous: "/player/prev", stop: "/player/pause" },
  },

  externalCommand(source, action) {
    const base = (this.config.externalControl || {})[source]
    const path = (this.externalPaths[source] || {})[action]
    if (!base || !path) return
    fetch(base + path, { method: "POST", mode: "no-cors" }).catch(() => {})
  },

  // radio starts -> stop YouTube, pause Spotify (the sound card would play both in parallel)
  stopExternal() {
    this.external = null
    this.externalCommand("youtube", "stop")
    this.externalCommand("spotify", "pause")
  },

  getCarouselKeys() {
    const self = this
    const keys = []
    for (let curId = 0; curId < self.config.stations.length; curId++) {
      if ((typeof self.config.stations[curId].profiles === 'undefined') ||
          (self.currentProfilePattern.test(self.config.stations[curId].profiles))) {
        keys.push(curId)
      }
    }
    for (const source of self.config.externalSources || []) {
      const active = self.external && self.external.source === source
      if (active || self.config.showExternalWhenIdle) keys.push("ext:" + source)
    }
    return keys
  },

  getCarouselItemDom(key) {
    return (typeof key === "string" && key.startsWith("ext:"))
      ? this.getExternalItemDom(key.substring(4))
      : this.getStationDomObject(key)
  },

  getExternalItemDom(source) {
    const self = this
    const ext = (self.external && self.external.source === source) ? self.external : null
    const name = (self.config.externalNames || {})[source] || source
    const selected = self.displayKey() === "ext:" + source

    const wrapper = document.createElement("div")
    wrapper.className = "station external " + source + (ext ? " active" : " idle") +
      (selected ? " selected " + (ext && ext.playing ? "playing" : "stopped") : " unselected")
    if (selected) self.activeStation = wrapper
    if (ext) {
      wrapper.addEventListener("click", () => { self.externalCommand(source, ext.playing ? "pause" : "resume") })
    }

    const inner = document.createElement("div")
    inner.className = "innerWrapper"

    if (self.config.showLogos) {
      const logoWrapper = document.createElement("div")
      logoWrapper.className = "logoWrapper"
      if (ext && ext.cover) {
        const cover = document.createElement("img")
        cover.className = "logo cover"
        cover.src = ext.cover
        cover.referrerPolicy = "no-referrer"
        logoWrapper.appendChild(cover)
      } else {
        const icon = document.createElement("span")
        icon.className = "iconify extIcon"
        icon.setAttribute("data-icon", (self.config.externalIcons || {})[source] || "mdi:music")
        icon.setAttribute("data-inline", "false")
        logoWrapper.appendChild(icon)
      }
      inner.appendChild(logoWrapper)
    }

    const titleWrapper = document.createElement("div")
    titleWrapper.className = "titleWrapper"
    if (ext && selected) {
      const text = document.createElement("div")
      text.className = "extText"
      const label = document.createElement("span")
      label.className = "extSource"
      label.textContent = name + (ext.playing ? "" : " · " + self.translate("PAUSED"))
      const title = document.createElement("span")
      title.className = "extTitle"
      title.textContent = ext.title || ""
      const artist = document.createElement("span")
      artist.className = "extArtist"
      artist.textContent = ext.artist || ""
      text.appendChild(label); text.appendChild(title); text.appendChild(artist)
      titleWrapper.appendChild(text)
    } else if (self.config.showTitles) {
      titleWrapper.textContent = name
    }
    inner.appendChild(titleWrapper)

    wrapper.appendChild(inner)
    return wrapper

  },

  getTranslations: function() {
    return { en: "translations/en.json", de: "translations/de.json" }
  },

  getScripts: function() {
    return ['//code.iconify.design/1/1.0.5/iconify.min.js']
  },

  suspend: function() {
		const self = this
		if (self.config.stopOnSuspend){
      self.sendSocketNotification("RADIO_STOP")
    }
  },

  /**
   * Pseudo-constructor for our module. Sets the default current page to 0.
   */
  start() {
    const self = this
    Log.info("Starting module: " + self.name);
    for (let i = 0; i < self.config.stations.length; i++){
      if (typeof self.config.stations[i].title === "undefined"){
        let title = self.config.stations[i].url
        title = title.substring(title.lastIndexOf("/")+1)
        title = title.substring(0,title.lastIndexOf("."))
        self.config.stations[i].title = title
      }
    }

    self.sendSocketNotification('CONFIG', self.config);
    self.playing = false;
    self.activeStation = null;
    self.curStreamInfo = null;
    self.streamInfoObj = null;
    self.currentProfile = ''
    self.currentProfilePattern = new RegExp('.*')

    self.instanceCssClass = "mradio"

    if(self.config.autoplay !== null){
      self.curStationIndex = self.config.autoplay
      setTimeout(()=>{
        self.sendSocketNotification("RADIO_PLAY",{id: self.config.autoplay})
      }, 1000)
    } else {
      if(self.config.initStation !== null){
        self.curStationIndex = self.config.initStation
      } else {
        if (self.config.stations.length > 2){
          self.curStationIndex = self.getNextStationId(1, type=0)
        } else {
          self.curStationIndex = self.getNextStationId(0, type=0)
        }
      }

    }
  },

  getStationDomObject: function(id){
    const self = this
    let curId = id
    let stationWrapper = document.createElement("div")
      stationWrapper.addEventListener("click", ()=>{self.notificationReceived("RADIO_PLAY", {
        id: curId
      })})
      if(self.displayKey() === curId){
        self.activeStation = stationWrapper
        if(self.playing){
          stationWrapper.className = "station selected playing"
        } else {
          stationWrapper.className = "station selected stopped"
        }

      } else {
        stationWrapper.className = "station unselected"
      }

      let stationInnerWrapper = document.createElement("div")
        stationInnerWrapper.className = "innerWrapper"
        if(self.config.showLogos){
          let stationLogoWrapper = document.createElement("div")
            stationLogoWrapper.className = "logoWrapper"
            let stationLogo = document.createElement("img")
              stationLogo.className = "logo"
              if(typeof self.config.stations[curId].logo !== "undefined"){
                stationLogo.src = self.config.stations[curId].logo
              } else {
                stationLogo.src = self.config.missingLogoUrl
              }
            stationLogoWrapper.appendChild(stationLogo)
          stationInnerWrapper.appendChild(stationLogoWrapper)
        }

        if (self.config.showTitles){
          let stationTitleWrapper = document.createElement("div")
            stationTitleWrapper.className = "titleWrapper"
            stationTitleWrapper.innerHTML = self.config.stations[curId].title
          stationInnerWrapper.appendChild(stationTitleWrapper)
        }

      stationWrapper.appendChild(stationInnerWrapper)
    return stationWrapper
  },

  getStreamInfoDom(){
    const self = this
    let streamInfoWrapper = document.createElement("div")
      streamInfoWrapper.className = "streamInfoWrapper"

      if (self.external){
        streamInfoWrapper.innerHTML = "&nbsp;"
      } else if (self.curStreamInfo != null){
        streamInfoWrapper.innerHTML = self.curStreamInfo
      } else {
        streamInfoWrapper.innerHTML = "&nbsp;"
      }
    return streamInfoWrapper
  },

  getControlDom(){
    const self = this
    let controlWrapper = document.createElement("div")
      controlWrapper.className = "controlWrapper"

      if (self.config.showVolControls == true){
        let volDownButtonWrapper = document.createElement("span")
          volDownButtonWrapper.className = "volDownButtonWrapper"
          volDownButtonWrapper.addEventListener("click", ()=>{self.sendNotification("VOLUME_DOWN")})
          let volDownButton = document.createElement("span")
            volDownButton.className = "button volDownButton iconify"
            volDownButton.setAttribute("data-icon", self.config.volDownIcon)
            volDownButton.setAttribute("data-inline", "false")
          volDownButtonWrapper.appendChild(volDownButton)
        controlWrapper.appendChild(volDownButtonWrapper)
      }
      let prevButtonWrapper = document.createElement("span")
        prevButtonWrapper.className = "previousButtonWrapper"
        prevButtonWrapper.addEventListener("click", ()=>{
          if (self.external) self.externalCommand(self.external.source, "previous")
          else self.notificationReceived("RADIO_PREVIOUS")
        })
        let prevButton = document.createElement("span")
          prevButton.className = "button previousButton iconify"
          prevButton.setAttribute("data-icon", self.config.previousIcon)
          prevButton.setAttribute("data-inline", "false")
        prevButtonWrapper.appendChild(prevButton)
      controlWrapper.appendChild(prevButtonWrapper)

      if (self.external){
        const ext = self.external
        let toggleWrapper = document.createElement("span")
          toggleWrapper.className = ext.playing ? "stopButtonWrapper" : "playButtonWrapper"
          toggleWrapper.addEventListener("click", ()=>{
            self.externalCommand(ext.source, ext.playing ? "pause" : "resume")
          })
          let toggleButton = document.createElement("span")
            toggleButton.className = "button iconify " + (ext.playing ? "pauseButton" : "playButton")
            toggleButton.setAttribute("data-icon", ext.playing ? self.config.pauseIcon : self.config.playIcon)
            toggleButton.setAttribute("data-inline", "false")
          toggleWrapper.appendChild(toggleButton)
        controlWrapper.appendChild(toggleWrapper)
      } else if(this.playing){
        let stopButtonWrapper = document.createElement("span")
          stopButtonWrapper.className = "stopButtonWrapper"
          stopButtonWrapper.addEventListener("click", ()=>{self.notificationReceived("RADIO_STOP")})
          let stopButton = document.createElement("span")
            stopButton.className = "button stopButton iconify"
            stopButton.setAttribute("data-icon", this.config.stopIcon)
            stopButton.setAttribute("data-inline", "false")
          stopButtonWrapper.appendChild(stopButton)
        controlWrapper.appendChild(stopButtonWrapper)
      } else {
        let playButtonWrapper = document.createElement("span")
          playButtonWrapper.className = "playButtonWrapper"
          playButtonWrapper.addEventListener("click", ()=>{
            self.notificationReceived("RADIO_PLAY",
              {
                id: self.curStationIndex,
              }
            )})
          let playButton = document.createElement("span")
            playButton.className = "button playButton iconify"
            playButton.setAttribute("data-icon", this.config.playIcon)
            playButton.setAttribute("data-inline", "false")
          playButtonWrapper.appendChild(playButton)
        controlWrapper.appendChild(playButtonWrapper)
      }

      let nextButtonWrapper = document.createElement("span")
        nextButtonWrapper.className = "nextButtonWrapper"
        nextButtonWrapper.addEventListener("click", ()=>{
          if (self.external) self.externalCommand(self.external.source, "next")
          else self.notificationReceived("RADIO_NEXT")
        })
        let nextButton = document.createElement("span")
          nextButton.className = "button nextButton iconify"
          nextButton.setAttribute("data-icon", self.config.nextIcon)
          nextButton.setAttribute("data-inline", "false")
        nextButtonWrapper.appendChild(nextButton)
      controlWrapper.appendChild(nextButtonWrapper)

      if (self.config.showVolControls == true){
        let volUpButtonWrapper = document.createElement("span")
          volUpButtonWrapper.className = "volUpButtonWrapper"
          volUpButtonWrapper.addEventListener("click", ()=>{self.sendNotification("VOLUME_UP")})
          let volUpButton = document.createElement("span")
            volUpButton.className = "button volUpButton iconify"
            volUpButton.setAttribute("data-icon", self.config.volUpIcon)
            volUpButton.setAttribute("data-inline", "false")
          volUpButtonWrapper.appendChild(volUpButton)
        controlWrapper.appendChild(volUpButtonWrapper)
      }

    return controlWrapper
  },

  /**
   * Render the cicles for each page, and highlighting the page we're on.
   */
  getDom() {
    const self = this
    let wrapper = document.createElement("div")
      wrapper.className = self.instanceCssClass+" wrapper"

      if(self.config.showStations){
        let stationsWrapper = document.createElement("div")
          stationsWrapper.className = "stationsWrapper"
          if(self.config.showStations){
            const keys = self.getCarouselKeys()
            const around = self.config.stationsBeforeAndAfter
            if (self.config.scrollableStations || (keys.length < ((around * 2)+1))){
              for (const key of keys){
                stationsWrapper.appendChild(self.getCarouselItemDom(key))
              }
            } else {
              // window of 2*around+1 entries centered on the selected one, wrapping around
              let center = keys.indexOf(self.displayKey())
              if (center < 0) center = 0
              for (let offset = -around; offset <= around; offset++){
                const key = keys[(center + offset + keys.length) % keys.length]
                stationsWrapper.appendChild(self.getCarouselItemDom(key))
              }
            }
          }
        wrapper.appendChild(stationsWrapper)
      }

      if(self.config.showStreamInfo){
		console.log("CUR_STREAM_INFO: "+self.curStreamInfo)
		self.streamInfoObj = self.getStreamInfoDom()
        wrapper.appendChild(self.streamInfoObj)
      }

      if(self.config.showControls){
        wrapper.appendChild(self.getControlDom())
      }

      self.updateScrollPosition(1000)
    return wrapper;
  },

  getNumberOfStationsInCurrentProfile: function(){
    const self = this
    if (self.currentProfile === ''){
      return self.config.stations.length
    } else {
      let curCount = 0;
      for (let curId = 0; curId < self.config.stations.length; curId ++){
        if(
          (typeof self.config.stations[curId].profiles === 'undefined') ||
          (self.currentProfilePattern.test(self.config.stations[curId].profiles))
        ){
          curCount += 1
        }
      }

      return curCount
    }
  },

  getNextStationId: function(curId, type=1){
    const self = this
    var retId = null
    curId = parseInt(curId)
    if (isNaN(curId)){
      curId = null
    }

    if(curId !== null){
      if(type > 0){
        console.log("Searching for fitting prev station")
        var newId = curId
        for(var i = 0; i < self.config.stations.length; i++){
          newId -= 1
          if(newId < 0){
            newId = self.config.stations.length - 1
          }

          if(
            (typeof self.config.stations[newId].profiles === 'undefined') ||
            ((typeof self.currentProfilePattern !== 'undefined') &&
            (self.currentProfilePattern.test(self.config.stations[newId].profiles)))
          ){
            retId = newId
            break
          }
        }
      } else if(type < 0){
        console.log("Searching for fitting next station")
        var newId = curId
        for(var i = 0; i < self.config.stations.length; i++){
          newId += 1
          if(newId > self.config.stations.length - 1){
            newId = 0
          }

          if(
            (typeof self.config.stations[newId].profiles === 'undefined') ||
            ((typeof self.currentProfilePattern !== 'undefined') &&
            (self.currentProfilePattern.test(self.config.stations[newId].profiles)))
          ){
            retId = newId
            break
          }
        }
      } else if(type === 0){
        if(
          (typeof self.config.stations[curId].profiles === 'undefined') ||
          ((typeof self.currentProfilePattern !== 'undefined') &&
          (self.currentProfilePattern.test(self.config.stations[curId].profiles)))
        ){
          console.log("Station with id: "+curId+" is ok for profile: "+self.currentProfile)
          return curId
        } else {
          console.log("Station with id: "+curId+" is NOT ok for profile: "+self.currentProfile)
          return self.getNextStationId(curId, -1)
        }
      }
    } else {
      return self.getNextStationId(0,1)
    }
    return retId
  },

  updateScrollPosition: function(timeout){
    const self = this
    if((self.config.scrollableStations)&&(self.config.scrollToActiveStation && (self.activeStation != null))){
      setTimeout(()=>{
        self.activeStation.parentNode.scrollTop = self.activeStation.offsetTop - self.activeStation.parentNode.offsetTop
      }, timeout)
    }
  },

  notificationReceived: function(notification,payload) {
    const self = this
    // external sources (Spotify / YouTube Music) report what they play
    if (notification === "RADIO_EXTERNAL") {
      if (payload && payload.active) {
        // A paused source must not take over while the radio plays or another source is active.
        // This happens when the radio pauses Spotify or YouTube pauses it in the background.
        if (!payload.playing &&
            (self.playing || (self.external && self.external.source !== payload.source))) {
          return
        }
        self.external = payload
      } else if (self.external && (!payload || payload.source === self.external.source)) {
        self.external = null
      }
      self.updateDom(self.config.animationSpeed)
      return
    }
    // radio starts (touch, remote control, ...) -> stop YouTube, pause Spotify;
    // the sound card mixes streams, without this both would play at the same time
    if (["RADIO_PLAY", "RADIO_NEXT", "RADIO_PREVIOUS"].includes(notification) ||
        (notification === "RADIO_TOGGLE" && !self.playing)) {
      self.stopExternal()
    }
    if (notification === 'CHANGED_PROFILE'){
      if(typeof payload.to !== 'undefined'){
        console.log("Updating profile information to: "+payload.to)
        self.currentProfile = payload.to
        self.currentProfilePattern = new RegExp('\\b'+payload.to+'\\b')

        if(self.config.changeStationOnProfileChange){
          var newId = self.getNextStationId(self.curStationIndex, 0)

          if(newId !== self.curStationIndex){
            self.curStationIndex = newId
            if(self.playing){
              self.sendSocketNotification("RADIO_PLAY", {
                id: newId,
              })
            } else {
              self.curStreamInfo = payload.curStreamInfo
            }
          }
        }

        self.updateDom(this.config.animationSpeed)
      }
    } else if (notification === 'RADIO_NEXT'){
      self.sendSocketNotification("RADIO_PLAY", {
        id: self.getNextStationId(self.curStationIndex, -1),
      })
    } else if (notification === 'RADIO_PREVIOUS'){
      self.sendSocketNotification("RADIO_PLAY", {
        id: self.getNextStationId(self.curStationIndex, 1),
      })
    } else if (notification === "RADIO_TOGGLE") {
      if(self.playing){
        self.sendSocketNotification("RADIO_STOP")
      } else {
        self.sendSocketNotification("RADIO_PLAY", {
          id: self.curStationIndex,
        })
      }
    } else if( (notification === "RADIO_PLAY") ||
               (notification === "RADIO_STOP")
    ){
      console.log("RADIO: Notification->"+notification)
      console.log("RADIO: PAYLOAD->"+JSON.stringify(payload))
      if ((payload === null) ||
          (typeof payload === "undefined")
      ){
        payload = {}
      }

      if (
        (typeof payload['id'] === "undefined") &&
        (typeof payload['id'] === "undefined")
      ){
        payload["id"] = self.curStationIndex
      }
      this.sendSocketNotification(notification,payload)
    }
  },

  socketNotificationReceived: function (notification, payload) {
    const self = this
    if(notification === "RADIO_PLAYING"){
      this.external = null
      this.curStationIndex = payload.curStationIndex
      this.curStreamInfo = payload.curStreamInfo
      this.playing = true
      this.updateDom(this.config.animationSpeed)
    } else if(notification === "RADIO_STOPPED"){
      this.curStreamInfo = null
      this.playing = false
      this.updateDom(this.config.animationSpeed)
    } else if(notification === "RADIO_CURRENT_STREAM_INFO"){
      console.log("Updating Stream Info: "+payload.curStreamInfo)
      this.curStreamInfo = payload.curStreamInfo
      this.playing = true
      //this.updateDom(this.config.animationSpeed)
      if (this.streamInfoObj !== null){
        this.streamInfoObj.innerHTML = this.curStreamInfo
      }

    }
  },

});
