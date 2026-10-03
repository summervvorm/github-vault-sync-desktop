/**
 * 功能性 Obsidian API 桩。
 *
 * 与 test/stubs/obsidian.cjs 的区别：那个只是"能让 bundle 被 require"的空壳，
 * 这个实现了足够的行为，可以真正调用插件的 onload() / runSync() / onunload()，
 * 从而在 Obsidian 之外验证插件的运行时行为（命令注册、状态栏、设置页渲染、
 * 事件注册、真实 git 同步）。
 *
 * 它不追求完整复刻 Obsidian，只覆盖本插件实际用到的 API 面。
 */

export interface FakeElement {
  style: Record<string, string>;
  className: string;
  title: string;
  textContent: string;
  children: FakeElement[];
  empty(): void;
  setText(text: string): void;
  addClass(cls: string): void;
  removeClass(cls: string): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, handler: () => void): void;
  appendChild(child: FakeElement): FakeElement;
  createEl(tag: string, options?: { text?: string; cls?: string }): FakeElement;
}

export function createElement(): FakeElement {
  const el: FakeElement = {
    style: {},
    className: '',
    title: '',
    textContent: '',
    children: [],
    empty() {
      el.children.length = 0;
    },
    setText(text: string) {
      el.textContent = text;
    },
    addClass(cls: string) {
      el.className = `${el.className} ${cls}`.trim();
    },
    removeClass(cls: string) {
      el.className = el.className
        .split(' ')
        .filter((part) => part !== cls && part.length > 0)
        .join(' ');
    },
    setAttribute() {},
    addEventListener() {},
    appendChild(child: FakeElement) {
      el.children.push(child);
      return child;
    },
    createEl(_tag: string, options?: { text?: string; cls?: string }) {
      const child = createElement();
      if (options?.text) {
        child.setText(options.text);
      }
      if (options?.cls) {
        child.addClass(options.cls);
      }
      el.children.push(child);
      return child;
    },
  };
  return el;
}

/** 测试可观察的注册表 */
export const registry = {
  statusBarItems: [] as FakeElement[],
  notices: [] as string[],
  commands: [] as Array<{ id: string; name: string }>,
  settingTabs: [] as unknown[],
  events: [] as unknown[],
  intervals: [] as number[],
  modalOpens: 0,
};

export function resetRegistry(): void {
  registry.statusBarItems.length = 0;
  registry.notices.length = 0;
  registry.commands.length = 0;
  registry.settingTabs.length = 0;
  registry.events.length = 0;
  registry.intervals.length = 0;
  registry.modalOpens = 0;
}

export class FileSystemAdapter {
  private basePath = '';

  setBasePath(path: string): void {
    this.basePath = path;
  }

  getBasePath(): string {
    return this.basePath;
  }
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  private storedData: unknown = null;

  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return this.storedData;
  }

  async saveData(data: unknown): Promise<void> {
    this.storedData = JSON.parse(JSON.stringify(data));
  }

  /** 测试用：预置 data.json 内容 */
  __setStoredData(data: unknown): void {
    this.storedData = data;
  }

  /** 测试用：读回最后一次保存的内容 */
  __getStoredData(): unknown {
    return this.storedData;
  }

  addStatusBarItem(): FakeElement {
    const el = createElement();
    registry.statusBarItems.push(el);
    return el;
  }

  addSettingTab(tab: unknown): void {
    registry.settingTabs.push(tab);
  }

  addCommand(command: { id: string; name: string }): void {
    registry.commands.push(command);
  }

  registerEvent(ref: unknown): void {
    registry.events.push(ref);
  }

  registerInterval(id: number): number {
    registry.intervals.push(id);
    return id;
  }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: FakeElement;

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createElement();
  }
}

export class Setting {
  settingEl: FakeElement;

  constructor(containerEl?: FakeElement) {
    // 真实 Obsidian 的 Setting 会把一行设置挂到容器上；
    // 桩也照做，否则"设置页渲染出了内容"这条断言永远是 0，等于没测。
    this.settingEl = createElement();
    containerEl?.appendChild(this.settingEl);
  }

  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
}

export class Modal {
  app: unknown;
  contentEl: FakeElement;

  constructor(app: unknown) {
    this.app = app;
    this.contentEl = createElement();
  }

  open(): void {
    registry.modalOpens += 1;
  }

  close(): void {}
}

export class Notice {
  constructor(message: string) {
    registry.notices.push(message);
  }
}

export class Component {}
export class Events {}
