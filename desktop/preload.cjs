'use strict';
/**
 * Velxio OSS Desktop - preload.
 *
 * contextIsolation stays ON and no privileged API is exposed. The app talks to
 * its local backend over plain HTTP through the wrapper's reverse proxy, so the
 * renderer never needs Node access. The API base itself is injected into the
 * page by the wrapper's HTTP server (see lib/server.cjs), not from here.
 *
 * Original file - part of the unofficial community desktop wrapper.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('velxioDesktop', {
  unofficial: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
