import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import moment, { Moment } from "moment";
import { FormatId, transformText } from "./formatting";

const VIEW_TYPE = "day-one-shell-view";
const DAILY_FOLDER = "daily";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
type BrowserMode = "list" | "grid" | "map" | "calendar";
type FilterMode = "all" | "today" | "on-this-day";

const FORMAT_ACTIONS: Array<{ id: FormatId; label: string; icon?: string; short?: string }> = [
  { id: "clear", label: "Clear formatting", icon: "eraser" },
  { id: "bold", label: "Bold", icon: "bold" },
  { id: "italic", label: "Italic", icon: "italic" },
  { id: "highlight", label: "Highlight", icon: "highlighter" },
  { id: "strike", label: "Strikethrough", icon: "strikethrough" },
  { id: "underline", label: "Underline", icon: "underline" },
  { id: "link", label: "Link", icon: "link" },
  { id: "code", label: "Code span", icon: "code" },
  { id: "quote", label: "Quote block", icon: "quote" },
  { id: "codeblock", label: "Code block", icon: "square-code" },
  { id: "bullet", label: "Bulleted list", icon: "list" },
  { id: "number", label: "Numbered list", icon: "list-ordered" },
  { id: "check", label: "Checklist", icon: "list-checks" },
  { id: "rule", label: "Rule line", icon: "minus" },
  { id: "indent", label: "Indent", icon: "indent-increase" },
  { id: "outdent", label: "Outdent", icon: "indent-decrease" },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ id: `h${level}` as FormatId, label: `Header ${level}`, short: `H${level}` })),
];

function renderFormatControls(parent: HTMLElement, apply: (id: FormatId) => void): void {
  for (const action of FORMAT_ACTIONS) {
    const button = parent.createEl("button", {
      cls: "day-one-format-action",
      attr: { type: "button", title: action.label, "aria-label": action.label },
    });
    if (action.icon) setIcon(button, action.icon);
    else button.createSpan({ text: action.short });
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.onclick = () => apply(action.id);
  }
}

interface Entry {
  file: TFile;
  date: Moment;
  line: number;
  title: string;
  preview: string;
  imageUrl?: string;
  location?: string;
  weather?: string;
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

function splitTimestampedEntries(raw: string): Array<{ text: string; line: number }> {
  const headings = Array.from(raw.matchAll(/^###\s+\d{1,2}:\d{2}\s+[AP]M\s*$/gim));
  if (!headings.length) return [{ text: raw, line: 0 }];
  return headings.map((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? raw.length;
    return {
      text: raw.slice(start, end),
      line: raw.slice(0, start).split("\n").length - 1,
    };
  });
}

class CaptureModal extends Modal {
  private plugin: DayOneShellPlugin;
  private date: Moment;

  constructor(app: App, plugin: DayOneShellPlugin, date = moment()) {
    super(app);
    this.plugin = plugin;
    this.date = date;
  }

  onOpen(): void {
    this.modalEl.addClass("day-one-capture-modal");
    this.titleEl.setText("New journal entry");
    const hint = this.contentEl.createDiv({ cls: "day-one-capture-hint", text: this.date.format("dddd, MMMM D · h:mm A") });
    const input = this.contentEl.createEl("textarea", { attr: { placeholder: "What’s on your mind?", rows: "9" } });
    const format = this.contentEl.createDiv({ cls: "day-one-capture-format", attr: { "aria-label": "Text formatting" } });
    format.createSpan({ cls: "day-one-format-aa", text: "Aa" });
    const formatScroll = format.createDiv({ cls: "day-one-capture-format-scroll" });
    renderFormatControls(formatScroll, (id) => {
      const transformed = transformText(input.value, input.selectionStart, input.selectionEnd, id);
      input.value = transformed.value;
      input.focus();
      input.setSelectionRange(transformed.cursor, transformed.cursor);
    });
    const actions = this.contentEl.createDiv({ cls: "day-one-capture-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    cancel.onclick = () => this.close();
    save.onclick = async () => {
      const value = input.value.trim();
      if (!value) return;
      await this.plugin.appendCapture(value, this.date);
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
  private refreshTimer?: number;

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
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.parent?.path === DAILY_FOLDER) this.scheduleRefresh();
    }));
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

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.render(), 350);
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
      const isDefaultForOpenDay = this.app.workspace.getActiveFile()?.path === entry.file.path
        && !this.plugin.hasFocusedEntry(entry.file.path)
        && entries.find((candidate) => candidate.file.path === entry.file.path) === entry;
      const row = parent.createEl("button", { cls: `day-one-entry-row${this.plugin.isFocusedEntry(entry.file.path, entry.line) || isDefaultForOpenDay ? " is-selected" : ""}` });
      row.dataset.path = entry.file.path;
      row.dataset.line = String(entry.line);
      const badge = row.createDiv({ cls: "day-one-date-badge" });
      badge.createDiv({ cls: "weekday", text: entry.date.format("ddd").toUpperCase() });
      badge.createDiv({ cls: "day", text: entry.date.format("DD") });
      const copy = row.createDiv({ cls: "day-one-entry-copy" });
      copy.createDiv({ cls: "day-one-entry-title", text: entry.title });
      if (entry.preview) copy.createDiv({ cls: "day-one-entry-preview", text: entry.preview });
      const meta = copy.createDiv({ cls: "day-one-entry-meta", text: entry.date.format("h:mm A") });
      if (entry.location) meta.appendText(`  ·  ${entry.location}`);
      if (entry.imageUrl) row.createEl("img", { cls: "day-one-entry-thumb", attr: { src: entry.imageUrl, alt: "" } });
      row.onclick = () => this.plugin.openEntry(entry);
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
      card.onclick = () => this.plugin.openEntry(entry);
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
      row.onclick = () => this.plugin.openEntry(entry);
    }
  }

  private renderCalendar(parent: HTMLElement, entries: Entry[]): void {
    const entryMap = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = entry.date.format("YYYY-MM-DD");
      const dayEntries = entryMap.get(key) ?? [];
      dayEntries.push(entry);
      entryMap.set(key, dayEntries);
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
        const dayEntries = entryMap.get(key) ?? [];
        const entry = dayEntries.find((candidate) => candidate.imageUrl) ?? dayEntries[0];
        const stateLabel = dayEntries.length
          ? `${dayEntries.length} journal ${dayEntries.length === 1 ? "entry" : "entries"}`
          : "create journal entry";
        const cell = grid.createEl("button", {
          cls: `day-one-calendar-day${entry ? " has-entry" : ""}${date.isSame(today, "day") ? " is-today" : ""}${activeDate === key ? " is-selected" : ""}`,
          text: String(day),
          attr: { "aria-label": `${date.format("dddd, MMMM D, YYYY")}, ${stateLabel}`, title: `${date.format("MMMM D, YYYY")} · ${stateLabel}` },
        });
        cell.dataset.date = key;
        if (dayEntries.length > 1) cell.createSpan({ cls: "day-one-calendar-count", text: String(dayEntries.length) });
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
    let selectedDefault = false;
    this.contentEl.querySelectorAll<HTMLElement>(".day-one-entry-row").forEach((row) => {
      const line = Number(row.dataset.line);
      const exact = row.dataset.path === path && this.plugin.isFocusedEntry(path, line);
      const dayDefault = !selectedDefault && row.dataset.path === path && !this.plugin.hasFocusedEntry(path);
      row.toggleClass("is-selected", exact || dayDefault);
      if (dayDefault) selectedDefault = true;
    });
    this.contentEl.querySelectorAll<HTMLElement>(".day-one-calendar-day").forEach((cell) => cell.toggleClass("is-selected", cell.dataset.date === basename));
  }
}

export default class DayOneShellPlugin extends Plugin {
  private focusedEntry?: { path: string; line: number };

  isFocusedEntry(path: string | undefined, line: number): boolean {
    return Boolean(path && this.focusedEntry?.path === path && this.focusedEntry.line === line);
  }

  hasFocusedEntry(path: string | undefined): boolean {
    return Boolean(path && this.focusedEntry?.path === path);
  }

  async onload(): Promise<void> {
    document.body.addClass("day-one-vault");
    document.body.toggleClass("day-one-mobile", Platform.isMobile);
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
    document.body.removeClass("day-one-vault", "day-one-mobile", "day-one-mobile-editor-open");
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView(): Promise<void> {
    document.body.removeClass("day-one-mobile-editor-open");
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = Platform.isMobile
        ? this.app.workspace.getLeaf("tab")
        : this.app.workspace.getLeftLeaf(false) ?? this.app.workspace.getLeaf("split", "vertical");
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
          view.containerEl.removeClass("has-day-one-import", "has-multiple-day-one-entries");
          view.containerEl.querySelector(".day-one-editor-meta-bar")?.remove();
          view.containerEl.querySelector(".day-one-entry-jumpbar")?.remove();
          view.containerEl.querySelector(".day-one-format-toolbar")?.remove();
          view.containerEl.querySelector(".day-one-mobile-journal-back")?.remove();
        }
      }
    }, 80);
  }

  private async decorateEditor(view: MarkdownView, file: TFile, label: HTMLElement): Promise<void> {
    const header = label.parentElement ?? view.containerEl;
    const raw = await this.app.vault.cachedRead(file);
    view.containerEl.toggleClass("has-day-one-import", raw.includes("<!-- dayone-entry:"));
    const entries = await this.entriesForFile(file, raw);
    const focused = entries.find((entry) => this.focusedEntry?.path === file.path && this.focusedEntry.line === entry.line);
    view.containerEl.toggleClass("has-multiple-day-one-entries", entries.length > 1);
    label.setText(focused
      ? displayTimestamp(focused.date)
      : entries.length > 1
        ? `${moment(file.basename, "YYYY-MM-DD").format("ddd, MMM D, YYYY")} · ${entries.length} entries`
        : displayTimestamp(entries[0]?.date ?? moment(file.basename, "YYYY-MM-DD")));
    label.show();
    let back = header.querySelector<HTMLButtonElement>(".day-one-mobile-journal-back");
    if (!back) {
      back = header.createEl("button", {
        cls: "day-one-mobile-journal-back",
        attr: { type: "button", title: "Back to Journal", "aria-label": "Back to Journal" },
      });
      setIcon(back, "chevron-left");
      back.onclick = () => void this.activateView();
    }
    this.ensureFormatToolbar(view);

    let bar = view.containerEl.querySelector<HTMLElement>(".day-one-editor-meta-bar");
    if (!bar) bar = view.containerEl.createDiv({ cls: "day-one-editor-meta-bar" });
    bar.empty();
    bar.createSpan({ cls: "journal", text: "Journal" });
    if (!focused && entries.length > 1) bar.createSpan({ text: `${entries.length} entries today` });
    if (focused?.weather) bar.createSpan({ text: focused.weather });
    if (focused?.location) bar.createSpan({ cls: "location", text: focused.location });
    bar.show();

    let jumpbar = view.containerEl.querySelector<HTMLElement>(".day-one-entry-jumpbar");
    if (entries.length > 1) {
      if (!jumpbar) jumpbar = view.containerEl.createDiv({ cls: "day-one-entry-jumpbar" });
      jumpbar.empty();
      jumpbar.createSpan({ cls: "day-one-entry-jumpbar-label", text: `${entries.length} entries` });
      for (const entry of entries) {
        const selected = focused?.line === entry.line;
        const button = jumpbar.createEl("button", {
          cls: `day-one-entry-jump${selected ? " is-active" : ""}`,
          text: entry.date.format("h:mm A"),
          attr: { "aria-label": `Open entry from ${entry.date.format("h:mm A")}` },
        });
        button.onclick = () => {
          this.focusedEntry = { path: file.path, line: entry.line };
          this.focusEditorLine(view, entry.line);
          void this.decorateEditor(view, file, label);
        };
      }
      const add = jumpbar.createEl("button", { cls: "day-one-entry-jump add", text: "+ New" });
      add.onclick = () => {
        const now = moment();
        const target = moment(file.basename, "YYYY-MM-DD").hour(now.hour()).minute(now.minute()).second(now.second());
        new CaptureModal(this.app, this, target).open();
      };
    } else {
      jumpbar?.remove();
    }

    const decorateLines = () => {
      let needsTitle = true;
      const lines = view.containerEl.querySelectorAll<HTMLElement>(".markdown-source-view.mod-cm6 .cm-line");
      lines.forEach((line) => {
        line.removeClass("day-one-scaffold-line", "day-one-entry-title-line");
        const text = line.textContent?.trim() ?? "";
        const plain = text.replace(/^#+\s*/, "").trim();
        const isTimestamp = /^\d{1,2}:\d{2}\s+[AP]M$/i.test(plain);
        if (isTimestamp) needsTitle = true;
        const isScaffold = !plain || /^Journal$/i.test(plain) || isTimestamp || text.startsWith("<!--") || text.startsWith("📍") || Boolean(line.querySelector(".cm-em"));
        if (isScaffold) {
          line.addClass("day-one-scaffold-line");
        } else if (needsTitle && !text.startsWith("![[")) {
          line.addClass("day-one-entry-title-line");
          needsTitle = false;
        }
      });
    };
    decorateLines();
    window.setTimeout(decorateLines, 220);
    window.setTimeout(decorateLines, 700);
  }

  private ensureFormatToolbar(view: MarkdownView): void {
    let toolbar = view.containerEl.querySelector<HTMLElement>(".day-one-format-toolbar");
    if (toolbar) return;
    toolbar = view.containerEl.createDiv({ cls: "day-one-format-toolbar", attr: { "aria-label": "Text formatting" } });
    const panel = toolbar.createDiv({ cls: "day-one-format-panel" });
    renderFormatControls(panel, (id) => this.applyEditorFormat(view, id));
    const trigger = toolbar.createEl("button", {
      cls: "day-one-format-trigger",
      text: "Aa",
      attr: { type: "button", title: "Text formatting", "aria-label": "Text formatting", "aria-expanded": "false" },
    });
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.onclick = () => {
      const expanded = !toolbar?.hasClass("is-expanded");
      toolbar?.toggleClass("is-expanded", expanded);
      trigger.setAttr("aria-expanded", String(expanded));
    };
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (toolbar && !toolbar.contains(event.target as Node)) {
        toolbar.removeClass("is-expanded");
        trigger.setAttr("aria-expanded", "false");
      }
    });
  }

  private applyEditorFormat(view: MarkdownView, id: FormatId): void {
    const editor = view.editor;
    let from = editor.getCursor("from");
    let to = editor.getCursor("to");
    let start = editor.posToOffset(from);
    let end = editor.posToOffset(to);
    if (start === end && (["clear", "quote", "bullet", "number", "check", "indent", "outdent"].includes(id) || id.startsWith("h"))) {
      from = { line: from.line, ch: 0 };
      to = { line: to.line, ch: editor.getLine(to.line).length };
      start = editor.posToOffset(from);
      end = editor.posToOffset(to);
    }
    const original = editor.getValue();
    const transformed = transformText(original, start, end, id);
    editor.replaceRange(transformed.value.slice(start, transformed.value.length - (original.length - end)), from, to);
    editor.setCursor(editor.offsetToPos(transformed.cursor));
    editor.focus();
  }

  async entriesForFile(file: TFile, providedRaw?: string): Promise<Entry[]> {
    const raw = providedRaw ?? await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ?? {};
    return splitTimestampedEntries(raw).map(({ text: segment, line }): Entry => {
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
        const weather = segment.match(/[🌤☀️🌧]\s*([^*\n]+)/u)?.[1]?.trim();
        let imageUrl: string | undefined;
        const inlineEmbed = segment.match(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/)?.[1];
        const embedLink = inlineEmbed;
        if (embedLink) {
          const directImage = this.app.vault.getAbstractFileByPath(normalizePath(embedLink));
          const imageFile = directImage instanceof TFile
            ? directImage
            : this.app.metadataCache.getFirstLinkpathDest(embedLink, file.path);
          if (imageFile) imageUrl = this.app.vault.getResourcePath(imageFile);
        }
        return { file, date, line, title, preview, imageUrl, location, weather };
    });
  }

  async getEntries(): Promise<Entry[]> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.parent?.path === DAILY_FOLDER && DATE_RE.test(file.basename));
    const grouped = await Promise.all(files.map((file) => this.entriesForFile(file)));
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
    this.focusedEntry = undefined;
    await this.openFile(await this.ensureDailyNote(date));
  }

  async openEntry(entry: Entry): Promise<void> {
    this.focusedEntry = { path: entry.file.path, line: entry.line };
    await this.openFile(entry.file, entry.line);
  }

  async openFile(file: TFile, line?: number): Promise<void> {
    const markdownLeaf = this.app.workspace.getLeavesOfType("markdown")[0] ?? this.app.workspace.getLeaf("tab");
    await markdownLeaf.openFile(file);
    document.body.addClass("day-one-mobile-editor-open");
    this.app.workspace.setActiveLeaf(markdownLeaf, { focus: true });
    this.updateEditorDates();
    if (line !== undefined && markdownLeaf.view instanceof MarkdownView) {
      const view = markdownLeaf.view;
      window.setTimeout(() => this.focusEditorLine(view, line), 100);
    }
  }

  private focusEditorLine(view: MarkdownView, line: number): void {
    const target = { line: Math.min(line + 1, Math.max(0, view.editor.lineCount() - 1)), ch: 0 };
    view.editor.setCursor(target);
    view.editor.scrollIntoView({ from: target, to: target }, true);
  }

  async appendCapture(text: string, date = moment()): Promise<void> {
    const file = await this.ensureDailyNote(date);
    await this.app.vault.process(file, (current) => {
      const base = current.trimEnd();
      return `${base}\n\n### ${date.format("h:mm A")}\n\n${text}\n`;
    });
    const entries = await this.entriesForFile(file);
    const latest = entries[entries.length - 1];
    if (latest) await this.openEntry(latest);
    else await this.openFile(file);
    new Notice(date.isSame(moment(), "day") ? "Saved to today’s journal" : `Saved to ${date.format("MMMM D")}`);
  }
}
