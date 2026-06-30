"use strict";

const supportedNativeSupervisors = {
  "darwin:arm64": "cdxx-supervisor-darwin-arm64",
  "linux:arm64": "cdxx-supervisor-linux-arm64",
};

const packagedNativeSupervisors = {
  "darwin:arm64": "cdxx-supervisor-darwin-arm64",
  "linux:arm64": "cdxx-supervisor-linux-arm64",
};

function hostKey(platform = process.platform, arch = process.arch) {
  return `${platform}:${arch}`;
}

function supportedHostText() {
  return Object.keys(supportedNativeSupervisors)
    .map((key) => key.replace(":", "/"))
    .join(", ");
}

module.exports = {
  supportedNativeSupervisors,
  packagedNativeSupervisors,
  hostKey,
  supportedHostText,
};
