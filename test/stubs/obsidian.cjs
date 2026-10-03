/**
 * 'obsidian' 模块的桩实现，仅用于在纯 Node 环境下加载构建产物 main.js，
 * 验证 bundle 语法有效、插件类结构完整。不是对 Obsidian 运行时的模拟。
 */

function makeEl() {
  const el = {
    style: {},
    children: [],
    empty() {},
    setText() {},
    addClass() {},
    removeClass() {},
    setAttribute() {},
    addEventListener() {},
    appendChild(child) {
      el.children.push(child);
    },
    createEl() {
      return makeEl();
    },
  };
  return el;
}

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return null;
  }
  async saveData() {}
  addStatusBarItem() {
    return makeEl();
  }
  addSettingTab() {}
  addCommand() {}
  addRibbonIcon() {
    return makeEl();
  }
  registerEvent() {
    return {};
  }
  registerInterval() {
    return 0;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl();
  }
}

class Setting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addText() {
    return this;
  }
  addToggle() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addButton() {
    return this;
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = makeEl();
  }
  open() {}
  close() {}
}

class Notice {
  constructor(message) {
    this.message = message;
  }
}

class FileSystemAdapter {}

class Component {}

class Events {}

module.exports = {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  FileSystemAdapter,
  Component,
  Events,
};
