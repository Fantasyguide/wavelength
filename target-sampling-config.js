(function (global) {
  "use strict";

  // File-only settings for balanced games. Restart the server / reload local pages after editing.
  var config = Object.freeze({
    enabled: true,
    easyThreshold: 70,
    strength: 0.5,
    minEasyProbability: 0.10,
    maxEasyProbability: 0.90
  });

  if (typeof module !== "undefined" && module.exports) module.exports = config;
  else global.WLTargetSamplingConfig = config;
})(typeof window !== "undefined" ? window : globalThis);
