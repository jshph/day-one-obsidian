import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import moment, { Moment } from "moment";

const VIEW_TYPE = "day-one-shell-view";
const DAILY_FOLDER = "daily";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type BrowserMode = "list" | "grid" | "map" | "calendar";
type FilterMode = "all" | "today" | "on-this-day";

interface Entry {
  file: TFile;
  date: Moment;
  title: string;
  preview: string;
  imageUrl?: string;
  location?: string;
}

function displayTimestamp(date: Moment): string {
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date.toDate())
    .find((part) => part.type === "timeZoneName")?.value;
  return `${date.format("ddd, MMM D, YYYY [at] h:mm A")}${zone ? ` ${zone}` : ""}`;
}

function stripEntryText(raw: string): string[] {
  const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return withoutFrontmatter
    .split("\n")
    .map((line) => {
      const original = line.trim();
      const clean = original.replace(/^[-*>]\s*/, "").replace(/[*_`#]/g, "").trim();
      return { original, clean };
    })
    .filter(({ original, clean }) => clean && !original.startsWith("#") && !original.startsWith("<!--") && !clean.startsWith("![[") && !/^(📍|🌤|☀️|🌧|🏷|⭐)/u.test(clean))
    .map(({ clean }) => clean);
}

function friendlyMonth(date: Moment): string {
  return date.format("MMMM YYYY");
}

class CaptureModal extends Modal {
  private plugin: DayOneShellPlugin;

  constructor(app: App, plugin: DayOneShellPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass("day-one-capture-modal");
    this.titleEl.setText("New journal entry");
    const hint = this.contentEl.createDiv({ cls: "day-one-capture-hint", text: moment().format("dddd, MMMM D · h:mm A") });
    const input = this.contentEl.createEl("textarea", { attr: { placeholder: "What’s on your mind?", rows: "9" } });
    const actions = this.contentEl.createDiv({ cls: "day-one-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    cancel.onclick = () => this.close();
    save.onclick = async () => {
      const value = input.value.trim();
      if (!value) return;
      await this.plugin.appendCapture(value);
      this.close();
    };
    input.addEventListener("keydown", async (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        save.click();
      }
    });
    window.setTimeout(() => input.focus(), 30);
    hint.setAttr("aria-hidden", "true");
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DayOneShellView extends ItemView {
  plugin: DayOneShellPlugin;
  mode: BrowserMode = "list";
  filter: FilterMode = "all";
  search = "";
  private browserEl?: HTMLElement;
  private entries: Entry[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: DayOneShellPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Journal"; }
  getIcon(): string { return "book-heart"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("day-one-shell");
    await this.render();
    this.registerEvent(this.app.vault.on("create", () => this.render()));
    this.registerEvent(this.app.vault.on("delete", () => this.render()));
    this.registerEvent(this.app.vault.on("modify", () => this.renderBrowser()));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.updateSelection();
      this.plugin.updateEditorDates();
    }));
  }

  async render(): Promise<void> {
    this.entries = await this.plugin.getEntries();
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "day-one-shell-grid" });
    this.renderJournalRail(shell.createDiv({ cls: "day-one-journal-rail" }));
    this.browserEl = shell.createDiv({ cls: "day-one-browser" });
    this.renderBrowser();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, active = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: `day-one-icon-button${active ? " is-active" : ""}`, attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.onclick = onClick;
    return button;
  }

  private railButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, trailing?: string, active = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: `day-one-rail-button${active ? " is-active" : ""}` });
    const iconEl = button.createSpan({ cls: "day-one-rail-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ cls: "day-one-rail-label", text: label });
    if (trailing) button.createSpan({ cls: "day-one-rail-trailing", text: trailing });
    button.onclick = onClick;
    return button;
  }

  private renderJournalRail(rail: HTMLElement): void {
    const windowDots = rail.createDiv({ cls: "day-one-window-dots", attr: { "aria-hidden": "true" } });
    windowDots.createSpan({ cls: "red" });
    windowDots.createSpan({ cls: "yellow" });
    windowDots.createSpan({ cls: "green" });
    const compose = this.iconButton(rail, "square-pen", "New journal entry", () => new CaptureModal(this.app, this.plugin).open());
    compose.addClass("day-one-compose");

    const nav = rail.createDiv({ cls: "day-one-rail-nav" });
    this.railButton(nav, "sunrise", "Today", async () => {
      this.filter = "today";
      this.mode = "list";
      await this.plugin.openDate(moment());
      await this.render();
    }, undefined, this.filter === "today");
    this.railButton(nav, "circle-ellipsis", "More", () => {
      this.filter = "all";
      this.mode = "list";
      this.render();
    });
    const onThisDayCount = this.entries.filter((e) => e.date.format("MM-DD") === moment().format("MM-DD") && e.date.year() !== moment().year()).length;
    this.railButton(nav, "calendar-days", "On This Day", () => {
      this.filter = "on-this-day";
      this.mode = "list";
      this.render();
    }, String(onThisDayCount), this.filter === "on-this-day");

    rail.createDiv({ cls: "day-one-rail-divider" });
    const heading = rail.createDiv({ cls: "day-one-journals-heading" });
    heading.createSpan({ text: "Journals" });
    const add = heading.createEl("button", { text: "＋ Add", attr: { title: "Create a new journal folder" } });
    add.onclick = () => new Notice("This vault starts with one Journal. Add folders whenever you actually need them.");

    const journal = rail.createEl("button", { cls: "day-one-journal-row is-active" });
    journal.createSpan({ cls: "day-one-book" });
    journal.createSpan({ cls: "day-one-journal-label", text: "Journal" });
    journal.createSpan({ cls: "day-one-journal-count", text: String(this.entries.length) });
    journal.onclick = () => { this.filter = "all"; this.render(); };

    rail.createDiv({ cls: "day-one-rail-divider" });
    const lower = rail.createDiv({ cls: "day-one-rail-lower" });
    this.railButton(lower, "trash-2", "Trash", () => new Notice("Deleted notes remain in Obsidian’s .trash folder."), "0");
    this.railButton(lower, "settings", "Settings", () => (this.app as any).setting?.open());
    this.railButton(lower, "map-pin", "Location History", () => { this.mode = "map"; this.renderBrowser(); });
  }

  private filteredEntries(): Entry[] {
    let result = this.entries;
    if (this.filter === "today") result = result.filter((e) => e.date.isSame(moment(), "day"));
    if (this.filter === "on-this-day") result = result.filter((e) => e.date.format("MM-DD") === moment().format("MM-DD") && e.date.year() !== moment().year());
    const q = this.search.trim().toLowerCase();
    if (q) result = result.filter((e) => `${e.title} ${e.preview} ${e.location ?? ""}`.toLowerCase().includes(q));
    return result;
  }

  renderBrowser(): void {
    if (!this.browserEl) return;
    this.browserEl.empty();
    this.renderBrowserToolbar(this.browserEl);
    const scroll = this.browserEl.createDiv({ cls: `day-one-browser-scroll mode-${this.mode}` });
    const entries = this.filteredEntries();
    if (this.mode === "list") this.renderList(scroll, entries);
    if (this.mode === "calendar") this.renderCalendar(scroll, entries);
    if (this.mode === "grid") this.renderGrid(scroll, entries);
    if (this.mode === "map") this.renderMap(scroll, entries);
  }

  private renderBrowserToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "day-one-browser-toolbar" });
    const modes = toolbar.createDiv({ cls: "day-one-mode-switcher" });
    this.iconButton(modes, "list", "List", () => { this.mode = "list"; this.renderBrowser(); }, this.mode === "list");
    this.iconButton(modes, "layout-grid", "Photos", () => { this.mode = "grid"; this.renderBrowser(); }, this.mode === "grid");
    this.iconButton(modes, "map", "Map", () => { this.mode = "map"; this.renderBrowser(); }, this.mode === "map");
    this.iconButton(modes, "calendar-days", "Calendar", () => { this.mode = "calendar"; this.renderBrowser(); }, this.mode === "calendar");
    const tools = toolbar.createDiv({ cls: "day-one-browser-tools" });
    const searchWrap = tools.createDiv({ cls: "day-one-search-wrap" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", { attr: { type: "search", placeholder: "Search" }, value: this.search });
    search.addEventListener("input", () => { this.search = search.value; this.renderBrowser(); });
    this.iconButton(tools, "list-filter", "Filter", () => { this.filter = this.filter === "all" ? "today" : "all"; this.render(); }, this.filter !== "all");
  }

  private renderList(parent: HTMLElement, entries: Entry[]): void {
    if (!entries.length) return this.renderEmpty(parent, this.filter === "on-this-day" ? "No memories from this day yet" : "No journal entries yet");
    let month = "";
    for (const entry of entries) {
      const nextMonth = friendlyMonth(entry.date);
      if (nextMonth !== month) {
        month = nextMonth;
        parent.createEl("h2", { cls: "day-one-month-heading", text: month });
      }
      const row = parent.createEl("button", { cls: `day-one-entry-row${this.app.workspace.getActiveFile()?.path === entry.file.path ? " is-selected" : ""}` });
      row.dataset.path = entry.file.path;
      const badge = row.createDiv({ cls: "day-one-date-badge" });
      badge.createDiv({ cls: "weekday", text: entry.date.format("ddd").toUpperCase() });
      badge.createDiv({ cls: "day", text: entry.date.format("DD") });
      const copy = row.createDiv({ cls: "day-one-entry-copy" });
      copy.createDiv({ cls: "day-one-entry-title", text: entry.title });
      if (entry.preview) copy.createDiv({ cls: "day-one-entry-preview", text: entry.preview });
      const meta = copy.createDiv({ cls: "day-one-entry-meta", text: entry.date.format("h:mm A") });
      if (entry.location) meta.appendText(`  ·  ${entry.location}`);
      if (entry.imageUrl) row.createEl("img", { cls: "day-one-entry-thumb", attr: { src: entry.imageUrl, alt: "" } });
      row.onclick = () => this.plugin.openFile(entry.file);
    }
  }

  private renderGrid(parent: HTMLElement, entries: Entry[]): void {
    parent.createEl("h2", { cls: "day-one-month-heading", text: "Photos" });
    const grid = parent.createDiv({ cls: "day-one-photo-grid" });
    const pictured = entries.filter((entry) => entry.imageUrl);
    if (!pictured.length) return this.renderEmpty(grid, "Photos in your entries will gather here");
    for (const entry of pictured) {
      const card = grid.createEl("button", { cls: "day-one-photo-card" });
      card.style.backgroundImage = `url("${entry.imageUrl}")`;
      const date = card.createSpan({ text: entry.date.format("MMM D") });
      date.createSpan({ text: ` · ${entry.title}` });
      card.onclick = () => this.plugin.openFile(entry.file);
    }
  }

  private renderMap(parent: HTMLElement, entries: Entry[]): void {
    parent.createEl("h2", { cls: "day-one-month-heading", text: "Location History" });
    const mapped = entries.filter((entry) => entry.location);
    if (!mapped.length) {
      const empty = parent.createDiv({ cls: "day-one-map-empty" });
      const pin = empty.createDiv();
      setIcon(pin, "map-pin");
      empty.createEl("h3", { text: "Your places will appear here" });
      empty.createEl("p", { text: "Imported Day One locations are shown automatically. New notes never require a location." });
      return;
    }
    for (const entry of mapped) {
      const row = parent.createEl("button", { cls: "day-one-location-row" });
      const pin = row.createSpan(); setIcon(pin, "map-pin");
      const copy = row.createSpan();
      copy.createEl("strong", { text: entry.location });
      copy.createEl("small", { text: `${entry.date.format("MMM D, YYYY")} · ${entry.title}` });
      row.onclick = () => this.plugin.openFile(entry.file);
    }
  }

  private renderCalendar(parent: HTMLElement, entries: Entry[]): void {
    const entryMap = new Map<string, Entry>();
    for (const entry of entries) {
      const key = entry.date.format("YYYY-MM-DD");
      const existing = entryMap.get(key);
      if (!existing || (!existing.imageUrl && entry.imageUrl)) entryMap.set(key, entry);
    }
    const months = new Set(entries.map((entry) => entry.date.format("YYYY-MM")));
    const today = moment();
    months.add(today.clone().subtract(1, "month").format("YYYY-MM"));
    months.add(today.format("YYYY-MM"));
    months.add(today.clone().add(1, "month").format("YYYY-MM"));
    const ordered = Array.from(months).sort();
    const weekdays = parent.createDiv({ cls: "day-one-weekdays" });
    for (const name of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) weekdays.createSpan({ text: name });
    const activeDate = this.app.workspace.getActiveFile()?.basename;
    for (const monthKey of ordered) {
      const current = moment(`${monthKey}-01`, "YYYY-MM-DD");
      const section = parent.createDiv({ cls: "day-one-calendar-month" });
      section.createEl("h2", { cls: "day-one-month-heading", text: friendlyMonth(current) });
      const grid = section.createDiv({ cls: "day-one-calendar-grid" });
      for (let blank = 0; blank < current.day(); blank++) grid.createSpan({ cls: "is-blank" });
      for (let day = 1; day <= current.daysInMonth(); day++) {
        const date = current.clone().date(day);
        const key = date.format("YYYY-MM-DD");
        const entry = entryMap.get(key);
        const stateLabel = entry ? "has journal entry" : "create journal entry";
        const cell = grid.createEl("button", {
          cls: `day-one-calendar-day${entry ? " has-entry" : ""}${date.isSame(today, "day") ? " is-today" : ""}${activeDate === key ? " is-selected" : ""}`,
          text: String(day),
          attr: { "aria-label": `${date.format("dddd, MMMM D, YYYY")}, ${stateLabel}`, title: `${date.format("MMMM D, YYYY")} · ${stateLabel}` },
        });
        cell.dataset.date = key;
        if (entry?.imageUrl) {
          cell.addClass("has-photo");
          cell.style.setProperty("background-image", `url("${entry.imageUrl}")`, "important");
        }
        cell.onclick = async () => {
          await this.plugin.openDate(date);
          this.updateSelection();
        };
      }
    }
  }

  private renderEmpty(parent: HTMLElement, message: string): void {
    const empty = parent.createDiv({ cls: "day-one-empty" });
    empty.createEl("p", { text: message });
    const button = empty.createEl("button", { cls: "mod-cta", text: "Write now" });
    button.onclick = () => new CaptureModal(this.app, this.plugin).open();
  }

  updateSelection(): void {
    const path = this.app.workspace.getActiveFile()?.path;
    const basename = this.app.workspace.getActiveFile()?.basename;
    this.contentEl.querySelectorAll<HTMLElement>(".day-one-entry-row").forEach((row) => row.toggleClass("is-selected", row.dataset.path === path));
    this.contentEl.querySelectorAll<HTMLElement>(".day-one-calendar-day").forEach((cell) => cell.toggleClass("is-selected", cell.dataset.date === basename));
  }
}

export default class DayOneShellPlugin extends Plugin {
  async onload(): Promise<void> {
    document.body.addClass("day-one-vault");
    this.registerView(VIEW_TYPE, (leaf) => new DayOneShellView(leaf, this));
    this.addCommand({ id: "open-journal", name: "Open journal", callback: () => this.activateView() });
    this.addCommand({ id: "quick-capture", name: "Quick capture", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "J" }], callback: () => new CaptureModal(this.app, this).open() });
    this.addRibbonIcon("square-pen", "Quick capture", () => new CaptureModal(this.app, this).open());
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateEditorDates()));
    this.app.workspace.onLayoutReady(async () => {
      await this.activateView();
      this.updateEditorDates();
    });
  }

  onunload(): void {
    document.body.removeClass("day-one-vault");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  updateEditorDates(): void {
    window.setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) continue;
        const header = view.containerEl.querySelector<HTMLElement>(".view-header");
        if (!header) continue;
        let label = header.querySelector<HTMLElement>(".day-one-editor-date");
        if (!label) label = header.createDiv({ cls: "day-one-editor-date" });
        const file = view.file;
        if (file && DATE_RE.test(file.basename)) {
          void this.decorateEditor(view, file, label);
        } else {
          label.hide();
          view.containerEl.removeClass("has-day-one-import");
          view.containerEl.querySelector(".day-one-editor-meta-bar")?.remove();
        }
      }
    }, 80);
  }

  private async decorateEditor(view: MarkdownView, file: TFile, label: HTMLElement): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    view.containerEl.toggleClass("has-day-one-import", raw.includes("<!-- dayone-entry:"));
    const firstBlock = raw.match(/<!-- dayone-entry:[A-F0-9-]+:start -->([\s\S]*?)<!-- dayone-entry:[A-F0-9-]+:end -->/i)?.[1] ?? raw;
    const headingTime = firstBlock.match(/^###\s+(\d{1,2}:\d{2}\s+[AP]M)/im)?.[1];
    const date = moment(file.basename, "YYYY-MM-DD");
    if (headingTime) {
      const parsed = moment(headingTime, "h:mm A");
      date.hour(parsed.hour()).minute(parsed.minute());
    } else {
      const modified = moment(file.stat.mtime);
      date.hour(modified.hour()).minute(modified.minute());
    }
    label.setText(displayTimestamp(date));
    label.show();

    const location = firstBlock.match(/📍\s*([^·\n*]+)/u)?.[1]?.trim();
    const weather = firstBlock.match(/[🌤☀️🌧]\s*([^*\n]+)/u)?.[1]?.trim();
    let bar = view.containerEl.querySelector<HTMLElement>(".day-one-editor-meta-bar");
    if (!bar) bar = view.containerEl.createDiv({ cls: "day-one-editor-meta-bar" });
    bar.empty();
    bar.createSpan({ cls: "journal", text: "Journal" });
    if (weather) bar.createSpan({ text: weather });
    if (location) bar.createSpan({ cls: "location", text: location });
    bar.toggle(Boolean(weather || location));

    const decorateLines = () => {
      let foundTitle = false;
      const lines = view.containerEl.querySelectorAll<HTMLElement>(".markdown-source-view.mod-cm6 .cm-line");
      lines.forEach((line) => {
        line.removeClass("day-one-scaffold-line", "day-one-entry-title-line");
        if (foundTitle) return;
        const text = line.textContent?.trim() ?? "";
        const plain = text.replace(/^#+\s*/, "").trim();
        const isScaffold = !plain || /^Journal$/i.test(plain) || /^\d{1,2}:\d{2}\s+[AP]M$/i.test(plain) || text.startsWith("<!--") || text.startsWith("📍") || Boolean(line.querySelector(".cm-em"));
        if (isScaffold) {
          line.addClass("day-one-scaffold-line");
        } else {
          line.addClass("day-one-entry-title-line");
          foundTitle = true;
        }
      });
    };
    decorateLines();
    window.setTimeout(decorateLines, 220);
    window.setTimeout(decorateLines, 700);
  }

  async getEntries(): Promise<Entry[]> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.parent?.path === DAILY_FOLDER && DATE_RE.test(file.basename));
    const grouped = await Promise.all(files.map(async (file): Promise<Entry[]> => {
      const raw = await this.app.vault.cachedRead(file);
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter ?? {};
      const blocks = Array.from(raw.matchAll(/<!-- dayone-entry:[A-F0-9-]+:start -->([\s\S]*?)<!-- dayone-entry:[A-F0-9-]+:end -->/gi));
      const segments = blocks.length ? blocks.map((match) => match[1]) : [raw];
      return segments.map((segment): Entry => {
        let date = moment(file.basename, "YYYY-MM-DD");
        const headingTime = segment.match(/^###\s+(\d{1,2}:\d{2}\s+[AP]M)/im)?.[1];
        const importedTimestamp = frontmatter.date || frontmatter.created || frontmatter.creationDate;
        if (headingTime) {
          const parsedTime = moment(headingTime, "h:mm A");
          date.hour(parsedTime.hour()).minute(parsedTime.minute());
        } else if (importedTimestamp && moment(importedTimestamp).isValid()) {
          date = moment(importedTimestamp);
        } else {
          const modified = moment(file.stat.mtime);
          date.hour(modified.hour()).minute(modified.minute()).second(modified.second());
        }
        const lines = stripEntryText(segment);
        const title = lines[0] || date.format("dddd, MMMM D");
        const preview = lines.slice(1).join(" ").slice(0, 170);
        const inlineLocation = segment.match(/^📍\s*([^·\n]+)/mu)?.[1]?.trim();
        const location = inlineLocation || frontmatter.location || frontmatter.place || frontmatter.address;
        let imageUrl: string | undefined;
        const inlineEmbed = segment.match(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/)?.[1];
        const embedLink = inlineEmbed || cache?.embeds?.find((item) => /\.(png|jpe?g|gif|webp|heic)$/i.test(item.link))?.link;
        if (embedLink) {
          const directImage = this.app.vault.getAbstractFileByPath(normalizePath(embedLink));
          const imageFile = directImage instanceof TFile
            ? directImage
            : this.app.metadataCache.getFirstLinkpathDest(embedLink, file.path);
          if (imageFile) imageUrl = this.app.vault.getResourcePath(imageFile);
        }
        return { file, date, title, preview, imageUrl, location };
      });
    }));
    return grouped.flat().sort((a, b) => b.date.valueOf() - a.date.valueOf());
  }

  async ensureDailyNote(date: Moment): Promise<TFile> {
    const path = normalizePath(`${DAILY_FOLDER}/${date.format("YYYY-MM-DD")}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    if (!this.app.vault.getAbstractFileByPath(DAILY_FOLDER)) await this.app.vault.createFolder(DAILY_FOLDER);
    return this.app.vault.create(path, "");
  }

  async openDate(date: Moment): Promise<void> {
    await this.openFile(await this.ensureDailyNote(date));
  }

  async openFile(file: TFile): Promise<void> {
    const markdownLeaf = this.app.workspace.getLeavesOfType("markdown")[0] ?? this.app.workspace.getLeaf("tab");
    await markdownLeaf.openFile(file);
    this.app.workspace.setActiveLeaf(markdownLeaf, { focus: true });
  }

  async appendCapture(text: string): Promise<void> {
    const file = await this.ensureDailyNote(moment());
    await this.app.vault.process(file, (current) => {
      const base = current.trimEnd();
      return `${base}\n\n### ${moment().format("h:mm A")}\n\n${text}\n`;
    });
    await this.openFile(file);
    new Notice("Saved to today’s journal");
  }
}
