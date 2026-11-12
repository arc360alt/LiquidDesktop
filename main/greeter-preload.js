// The login screen's only bridge to the system: who can log in, which sessions exist, log in, power.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('greeter', {
  info: () => ipcRenderer.invoke('greeter:info'),
  login: (user, password, session) => ipcRenderer.invoke('greeter:login', user, password, session),
  power: (action) => ipcRenderer.invoke('greeter:power', action),
});
