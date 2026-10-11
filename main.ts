import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ItemView,
  WorkspaceLeaf,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  EditorPosition,
  SuggestModal
} from "obsidian";

interface FileSettings {
  enabled: boolean;
  format?: string;
  chapterMode?: boolean | string;
}

interface EquationNumberingSettings {
  reuseNumberForDuplicates: boolean;
  anchorCharacter: string;
  labelPrefix: string;
  suggestCount: number;
  suggestSortMode: "smart" | "cursor" | "recent_edit" | "bottom_up";
  referenceFormatType: "chinese" | "eq" | "equation" | "parens" | "custom";
  referenceFormatTemplate: string;
  unifyReferenceFormat: boolean;
  enabledFiles: Record<string, FileSettings | boolean>;
}

const DEFAULT_SETTINGS: EquationNumberingSettings = {
  reuseNumberForDuplicates: true,
  anchorCharacter: "#",
  labelPrefix: "eq:",
  suggestCount: 5,
  suggestSortMode: "smart",
  referenceFormatType: "chinese",
  referenceFormatTemplate: "式（）",
  unifyReferenceFormat: false,
  enabledFiles: {}
};

// Regex to capture display math blocks. Handles tags and anchor tags if present.
const DISPLAY_MATH_WITH_ANCHOR = /(^|\n)(?:[ \t]*\\tag\*?\s*\{[^{}]*\}\s*\r?\n)?(?:<a\s+id="([^"]+)"[^>]*>[ \t]*<\/a>[ \t]*\n?)?([ \t>]*)\$\$((?:[^\$]|\$(?!\$))*?)\$\$(?:[ \t]*\\tag\*?\s*\{[^{}]*\}|\r?\n[ \t]*\\tag\*?\s*\{[^{}]*\})?/g;
const CODE_FENCE = /((?:^|\n)[ \t]*`{3,}[\s\S]*?`{3,}[ \t]*(?:\n|$)|(?:^|\n)[ \t]*~{3,}[ \t]*\w*[ \t]*\n[\s\S]*?(?:^|\n)[ \t]*~{3,}[ \t]*(?:\n|$))/gm;
const TAG = /\\tag\*?\s*\{[^{}]*\}/g;

function getChapterChar(n: number, uppercase: boolean = false): string {
  if (n <= 0) n = 1;
  let res = "";
  let temp = n;
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    res = String.fromCharCode((uppercase ? 65 : 97) + rem) + res;
    temp = Math.floor((temp - 1) / 26);
  }
  return res;
}

function isChapterFormat(format: string): boolean {
  if (!format) return false;
  return (
    format === "a-*" ||
    format === "(a-*)" ||
    format === "a.*" ||
    format === "A-*" ||
    format === "(A-*)" ||
    format === "A.*" ||
    format === "n.*" ||
    format === "(n.*)" ||
    format === "n-*" ||
    format === "(n-*)" ||
    format === "2.*" ||
    format === "2-*" ||
    /(?:^|[^a-zA-Z])a(?:[^a-zA-Z]|$)/.test(format) ||
    /(?:^|[^a-zA-Z])A(?:[^a-zA-Z]|$)/.test(format) ||
    /(?:^|[^a-zA-Z])n([.\-*])/.test(format) ||
    /\{ch(?:apter)?\}/i.test(format) ||
    /\[ch(?:apter)?\]/i.test(format) ||
    /\{n\}/i.test(format) ||
    /\[n\]/i.test(format)
  );
}

function getFormattedNumber(format: string, num: number, chapterIndex: number = 1): string {
  if (!format || format === "default") {
    return String(num);
  }
  let res = format;
  if (/\{ch\}/.test(res)) {
    res = res.replace(/\{ch\}/g, getChapterChar(chapterIndex, false));
  }
  if (/\{CH\}/.test(res)) {
    res = res.replace(/\{CH\}/g, getChapterChar(chapterIndex, true));
  }
  if (/\{chapter\}/i.test(res)) {
    const isUpper = /\{CHAPTER\}/.test(res);
    res = res.replace(/\{chapter\}/gi, getChapterChar(chapterIndex, isUpper));
  }
  if (/\[ch(?:apter)?\]/i.test(res)) {
    const isUpper = /\[CH(?:APTER)?\]/.test(res);
    res = res.replace(/\[ch(?:apter)?\]/gi, getChapterChar(chapterIndex, isUpper));
  }
  if (/\{n\}/i.test(res)) {
    res = res.replace(/\{n\}/gi, String(chapterIndex));
  }
  if (/\[n\]/i.test(res)) {
    res = res.replace(/\[n\]/gi, String(chapterIndex));
  }
  if (/(?:^|[^a-zA-Z])A(?:[^a-zA-Z]|$)/.test(res)) {
    const ch = getChapterChar(chapterIndex, true);
    res = res.replace(/(^|[^a-zA-Z])A([^a-zA-Z]|$)/g, `$1${ch}$2`);
  }
  if (/(?:^|[^a-zA-Z])a(?:[^a-zA-Z]|$)/.test(res)) {
    const ch = getChapterChar(chapterIndex, false);
    res = res.replace(/(^|[^a-zA-Z])a([^a-zA-Z]|$)/g, `$1${ch}$2`);
  }
  if (/(?:^|[^a-zA-Z])n([.\-*])/.test(res)) {
    res = res.replace(/(^|[^a-zA-Z])n([.\-*])/g, `$1${chapterIndex}$2`);
  }
  if (/^2([.\-*])/.test(res)) {
    res = res.replace(/^2([.\-*])/, `${chapterIndex}$1`);
  }
  if (res.includes("*")) {
    return res.replace(/\*/g, String(num));
  }
  return res;
}

function equationKey(body: string): string {
  return body
    .replace(/\\begin\s*\{equation\*\}/g, "\\begin{equation}")
    .replace(/\\end\s*\{equation\*\}/g, "\\end{equation}")
    .replace(TAG, "")
    .replace(/(?:%\s*)?\\label\s*\{[^{}]*\}/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\s+/g, " ");
}

function numberedBody(body: string, formattedNum: string): string {
  const normalized = body
    .replace(/\\begin\s*\{equation\*\}/g, "\\begin{equation}")
    .replace(/\\end\s*\{equation\*\}/g, "\\end{equation}");
  const trimmed = normalized
    .replace(TAG, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (normalized.includes("\n")) {
    return `\n${trimmed}\n\\tag{${formattedNum}}\n`;
  }
  return `${trimmed}\\tag{${formattedNum}}`;
}

export function getTemplateDisplayText(template: string, num: string): string {
  let cleanNum = (num || "").trim();
  if (
    (cleanNum.startsWith("(") && cleanNum.endsWith(")")) ||
    (cleanNum.startsWith("（") && cleanNum.endsWith("）"))
  ) {
    cleanNum = cleanNum.substring(1, cleanNum.length - 1).trim();
  }
  let tmpl = (template || "式（）").trim();
  if (tmpl.startsWith("[") && tmpl.endsWith("]")) {
    tmpl = tmpl.substring(1, tmpl.length - 1).trim();
  }
  if (/（\s*）/.test(tmpl)) {
    return tmpl.replace(/（\s*）/, `（${cleanNum}）`);
  } else if (/\(\s*\)/.test(tmpl)) {
    return tmpl.replace(/\(\s*\)/, `(${cleanNum})`);
  } else if (tmpl.includes("（") || tmpl.includes("）")) {
    return `${tmpl}（${cleanNum}）`;
  } else {
    return `${tmpl}(${cleanNum})`;
  }
}

export function renumberText(
  text: string,
  reuseNumberForDuplicates: boolean,
  format: string = "default",
  anchorCharacter: string = "#",
  chapterMode: boolean | string = false,
  unifyReferenceFormat: boolean = false,
  referenceFormatTemplate: string = "式（）"
): { text: string; equationCount: number; uniqueCount: number } {
  const seen = new Map<string, number>();
  const labelMap = new Map<string, string>();
  const isChapter = (!!chapterMode && chapterMode !== "unified") || isChapterFormat(format);
  let effectiveFormat = format;
  if (isChapter && (!format || format === "default")) {
    effectiveFormat = "a-*";
  }

  let headingRegex = /(?:^|\n)(#[ \t]+[^\n]*)/g;
  if (chapterMode === "chapter_h2") {
    headingRegex = /(?:^|\n)(##[ \t]+[^\n]*)/g;
  } else if (chapterMode === "chapter_h1") {
    headingRegex = /(?:^|\n)(#[ \t]+[^\n]*)/g;
  } else if (isChapter) {
    const nonCode = text.split(CODE_FENCE).filter((_, idx) => idx % 2 === 0).join("");
    const h1Count = (nonCode.match(/(?:^|\n)#[ \t]+[^\n]*/g) || []).length;
    const h2Count = (nonCode.match(/(?:^|\n)##[ \t]+[^\n]*/g) || []).length;
    if (h1Count <= 1 && h2Count >= 2) {
      headingRegex = /(?:^|\n)(##[ \t]+[^\n]*)/g;
    } else {
      headingRegex = /(?:^|\n)(#[ \t]+[^\n]*)/g;
    }
  }

  let currentChapter = 1;
  let chapterEqCount = 0;
  let nextNumber = 1;
  let totalEquationCount = 0;
  let seenAnyHeading = false;
  let totalUniqueSeen = 0;

  const parts = text.split(CODE_FENCE);
  const transformed = parts.map((part, index) => {
    if (index % 2 === 1) return part;

    const mathBlocks: Array<{ start: number; end: number; match: RegExpExecArray }> = [];
    const mathRegex = new RegExp(DISPLAY_MATH_WITH_ANCHOR.source, "g");
    let m: RegExpExecArray | null;
    while ((m = mathRegex.exec(part)) !== null) {
      mathBlocks.push({ start: m.index, end: m.index + m[0].length, match: m });
    }

    const isInMath = (pos: number) => mathBlocks.some(b => pos >= b.start && pos < b.end);

    const headings: Array<{ start: number; end: number; headingText: string }> = [];
    if (isChapter) {
      const hRegex = new RegExp(headingRegex.source, "g");
      let hm: RegExpExecArray | null;
      while ((hm = hRegex.exec(part)) !== null) {
        const matchStart = hm[0].startsWith("\n") ? hm.index + 1 : hm.index;
        if (!isInMath(matchStart)) {
          headings.push({ start: matchStart, end: matchStart + hm[1].length, headingText: hm[1] });
        }
      }
    }

    const items: Array<
      | { type: "heading"; start: number; end: number; headingText: string }
      | { type: "math"; start: number; end: number; match: RegExpExecArray }
    > = [
      ...headings.map(h => ({ type: "heading" as const, ...h })),
      ...mathBlocks.map(mb => ({ type: "math" as const, start: mb.start, end: mb.end, match: mb.match }))
    ].sort((a, b) => a.start - b.start);

    let result = "";
    let lastIndex = 0;

    for (const item of items) {
      if (item.type === "heading") {
        result += part.substring(lastIndex, item.start);
        result += part.substring(item.start, item.end);
        lastIndex = item.end;
        if (isChapter) {
          if (seenAnyHeading) {
            if (chapterEqCount > 0) {
              currentChapter++;
              nextNumber = 1;
              chapterEqCount = 0;
              if (reuseNumberForDuplicates) {
                totalUniqueSeen += seen.size;
                seen.clear();
              }
            }
          } else {
            seenAnyHeading = true;
            currentChapter = 1;
            nextNumber = 1;
            chapterEqCount = 0;
            if (reuseNumberForDuplicates) {
              totalUniqueSeen += seen.size;
              seen.clear();
            }
          }
        }
      } else if (item.type === "math") {
        result += part.substring(lastIndex, item.start);
        lastIndex = item.end;

        const full = item.match[0];
        const linePrefix = item.match[1] || "";
        const indent = item.match[3] || "";
        const body = item.match[4];

        const key = equationKey(body);
        if (!key) {
          result += full;
          continue;
        }

        totalEquationCount += 1;
        chapterEqCount += 1;
        let num = seen.get(key);
        if (num === undefined || !reuseNumberForDuplicates) {
          num = nextNumber;
          nextNumber += 1;
          if (reuseNumberForDuplicates) seen.set(key, num);
        }

        const formattedNum = getFormattedNumber(effectiveFormat, num, currentChapter);

        let newBody = body;
        const labelMatch = body.match(/(?:%\s*)?\\label\s*\{([^{}]+)\}/);
        let labelKey = "";
        if (labelMatch) {
          labelKey = labelMatch[1].trim();
          labelMap.set(labelKey, formattedNum);
          if (!labelMatch[0].startsWith("%")) {
            newBody = body.replace(/\\label\s*\{([^{}]+)\}/g, "% \\label{$1}");
          }
        }

        const newBodyAndTag = numberedBody(newBody, formattedNum);
        result += `${linePrefix}${indent}$$${newBodyAndTag}$$`;
      }
    }

    result += part.substring(lastIndex);
    return result;
  });

  let renumberedText = transformed.join("");

  const anchor = anchorCharacter || "#";
  const anchorEscaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linkRegex = new RegExp(`\\[([^\\]]*)\\]\\(${anchorEscaped}([^)]+)\\)`, "g");

  const partsForRefs = renumberedText.split(CODE_FENCE);
  const transformedRefs = partsForRefs.map((part, index) => {
    if (index % 2 === 1) return part;

    return part.replace(linkRegex, (match, displayText: string, labelKey: string) => {
      const trimmedLabel = labelKey.trim();
      if (labelMap.has(trimmedLabel)) {
        const formattedNum = labelMap.get(trimmedLabel)!;

        let cleanFormattedNum = formattedNum;
        if (
          (cleanFormattedNum.startsWith("(") && cleanFormattedNum.endsWith(")")) ||
          (cleanFormattedNum.startsWith("（") && cleanFormattedNum.endsWith("）"))
        ) {
          cleanFormattedNum = cleanFormattedNum.substring(1, cleanFormattedNum.length - 1);
        }

        let updatedDisplay = displayText;

        if (unifyReferenceFormat && referenceFormatTemplate) {
          updatedDisplay = getTemplateDisplayText(referenceFormatTemplate, cleanFormattedNum);
        } else {
          if (/（\s*）/.test(displayText)) {
            updatedDisplay = displayText.replace(/（\s*）/, `（${cleanFormattedNum}）`);
          } else if (/\(\s*\)/.test(displayText)) {
            updatedDisplay = displayText.replace(/\(\s*\)/, `(${cleanFormattedNum})`);
          } else if (/（[^（）]*\d+[^（）]*）/.test(displayText)) {
            updatedDisplay = displayText.replace(
              /（([^（）]*?)(?:[a-zA-Z0-9]+[-.])*(?:[a-zA-Z]-)?\d+(?:\.\d+)?([^（）]*?)）/,
              `（$1${cleanFormattedNum}$2）`
            );
          } else if (/\([^()]*\d+[^()]*\)/.test(displayText)) {
            updatedDisplay = displayText.replace(
              /\(([^()]*?)(?:[a-zA-Z0-9]+[-.])*(?:[a-zA-Z]-)?\d+(?:\.\d+)?([^()]*?)\)/,
              `($1${cleanFormattedNum}$2)`
            );
          } else if (/（[^（）]+）/.test(displayText)) {
            updatedDisplay = displayText.replace(/（[^（）]+）/, `（${cleanFormattedNum}）`);
          } else if (/\([^()]+\)/.test(displayText)) {
            updatedDisplay = displayText.replace(/\([^()]+\)/, `(${cleanFormattedNum})`);
          } else if (/(?:[a-zA-Z0-9]+[-.])*(?:[a-zA-Z]-)?\d+(?:\.\d+)?(?=[^0-9a-zA-Z]*$)/.test(displayText)) {
            updatedDisplay = displayText.replace(
              /(?:[a-zA-Z0-9]+[-.])*(?:[a-zA-Z]-)?\d+(?:\.\d+)?(?=[^0-9a-zA-Z]*$)/,
              cleanFormattedNum
            );
          } else if (displayText.trim() === "" || displayText === "?") {
            updatedDisplay = referenceFormatTemplate
              ? getTemplateDisplayText(referenceFormatTemplate, cleanFormattedNum)
              : formattedNum;
          }
        }

        return `[${updatedDisplay}](${anchor}${labelKey})`;
      }
      return match;
    });
  });

  renumberedText = transformedRefs.join("");

  renumberedText = renumberedText
    .split(/(\$\$[\s\S]*?\$\$)/g)
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      return part.replace(/^[ \t]*\\tag\*?\s*\{[^{}]*\}[ \t]*$\r?\n?/gm, "");
    })
    .join("");

  return {
    text: renumberedText,
    equationCount: totalEquationCount,
    uniqueCount: reuseNumberForDuplicates ? totalUniqueSeen + seen.size : totalEquationCount
  };
}

function getDiffRange(a: string, b: string): { from: number; to: number; text: string } | null {
  if (a === b) return null;
  let start = 0;
  const minLength = Math.min(a.length, b.length);
  while (start < minLength && a.charCodeAt(start) === b.charCodeAt(start)) {
    start++;
  }
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a.charCodeAt(aEnd) === b.charCodeAt(bEnd)) {
    aEnd--;
    bEnd--;
  }
  return {
    from: start,
    to: aEnd + 1,
    text: b.substring(start, bEnd + 1)
  };
}

const VIEW_TYPE_EQUATION_NUMBERING = "equation-numbering-view";

export class EquationNumberingView extends ItemView {
  plugin: AutoEquationNumberingPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: AutoEquationNumberingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_EQUATION_NUMBERING;
  }

  getDisplayText(): string {
    return "Equation Numbering";
  }

  getIcon(): string {
    return "list-ordered";
  }

  async onOpen(): Promise<void> {
    this.plugin.sidebarView = this;
    this.updateView();
  }

  async onClose(): Promise<void> {
    if (this.plugin.sidebarView === this) {
      this.plugin.sidebarView = null;
    }
  }

  updateView(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("equation-numbering-sidebar");

    const header = container.createDiv({ cls: "eqn-sidebar-header-container" });
    const logoWrapper = header.createEl("div", { cls: "eqn-sidebar-logo-wrapper" });
    logoWrapper.innerHTML = `
      <svg viewBox="0 0 64 64" width="64" height="64" class="eqn-sidebar-logo">
        <rect width="64" height="64" rx="16" fill="#1e2238"/>
        <g stroke-linecap="round" fill="none">
          <line x1="18" y1="22" x2="28" y2="22" stroke="#5c638c" stroke-width="3"/>
          <line x1="18" y1="32" x2="24" y2="32" stroke="#5c638c" stroke-width="3"/>
          <line x1="18" y1="42" x2="28" y2="42" stroke="#5c638c" stroke-width="3"/>
          <path d="M44,18 C39,18 36,24 36,32 C36,40 33,46 29,46 M32,32 L44,32" stroke="#7f8ffc" stroke-width="3.5"/>
          <circle cx="45" cy="24" r="1.5" fill="#7f8ffc" stroke="none"/>
        </g>
      </svg>
    `;
    header.createEl("div", { cls: "eqn-sidebar-title", text: "Equation Numbering" });
    header.createEl("div", { cls: "eqn-sidebar-subtitle", text: "公式管理 (Side Panel)" });

    const activeView = this.plugin.getActiveMarkdownView();
    if (!activeView || !activeView.file) {
      container.createEl("p", {
        text: "Open a markdown note to manage numbering.",
        cls: "setting-item-description eqn-centered-description"
      });
      return;
    }

    const path = activeView.file.path;
    const fileSettings = this.plugin.getFileSettings(path);
    const isEnabled = fileSettings.enabled;

    container.createDiv({ cls: "eqn-sidebar-divider" });

    new Setting(container)
      .setName("Enable for this Note")
      .addToggle(toggle =>
        toggle.setValue(isEnabled).onChange(async val => {
          await this.plugin.toggleNumberingForActiveFile();
          this.updateView();
        })
      )
      .settingEl.addClass("eqn-sidebar-setting-item");

    container.createDiv({ cls: "eqn-sidebar-divider" });

    new Setting(container)
      .setName("Numbering Mode")
      .addDropdown(dropdown => {
        dropdown.addOption("unified", "统一连续编号 (1, 2...)");
        dropdown.addOption("chapter_auto", "按章节重编号 (a-1, b-1... 智能识别)");
        dropdown.addOption("chapter_h1", "按 # 一级标题分章 (a-1, b-1...)");
        dropdown.addOption("chapter_h2", "按 ## 二级标题分章 (a-1, b-1...)");

        let currentVal = "unified";
        if (fileSettings.chapterMode === true || fileSettings.chapterMode === "chapter" || fileSettings.chapterMode === "chapter_auto") {
          currentVal = "chapter_auto";
        } else if (fileSettings.chapterMode === "chapter_h1") {
          currentVal = "chapter_h1";
        } else if (fileSettings.chapterMode === "chapter_h2") {
          currentVal = "chapter_h2";
        }

        dropdown.setValue(currentVal);
        dropdown.onChange(async val => {
          const modeVal = val === "unified" ? false : val;
          await this.plugin.setFileChapterMode(path, modeVal);
          if (isEnabled) {
            await this.plugin.updateNumberingForActiveFile();
          }
        });
      })
      .settingEl.addClass("eqn-sidebar-setting-item");

    container.createDiv({ cls: "eqn-sidebar-divider" });

    let customFormatSetting: Setting;
    let customInputEl: HTMLInputElement;

    new Setting(container)
      .setName("Format")
      .addDropdown(dropdown => {
        dropdown.addOption("default", "(n)");
        dropdown.addOption("a-*", "a-n (按章节)");
        dropdown.addOption("A-*", "A-n (按章节)");
        dropdown.addOption("n.*", "n.n (按章节)");
        dropdown.addOption("n-*", "n-n (按章节)");
        dropdown.addOption("(n-*)", "(n-n) (按章节)");
        dropdown.addOption("custom", "custom");

        const cur = fileSettings.format || "default";
        const normalizedCur = cur === "2.*" ? "n.*" : cur === "2-*" ? "(n-*)" : cur;
        const isCustom = !["default", "a-*", "A-*", "n.*", "n-*", "(n-*)", "custom"].includes(normalizedCur);

        dropdown.setValue(isCustom ? "custom" : normalizedCur);
        dropdown.onChange(async val => {
          if (val === "custom") {
            if (customFormatSetting) customFormatSetting.settingEl.show();
            const pattern = customInputEl ? customInputEl.value : "a-*";
            await this.plugin.setFileFormat(path, pattern);
          } else {
            if (customFormatSetting) customFormatSetting.settingEl.hide();
            await this.plugin.setFileFormat(path, val);
          }
          if (isEnabled) {
            await this.plugin.updateNumberingForActiveFile();
          }
        });
      })
      .settingEl.addClass("eqn-sidebar-setting-item");

    const cur = fileSettings.format || "default";
    const normalizedCur = cur === "2.*" ? "n.*" : cur === "2-*" ? "(n-*)" : cur;
    const isCustom = !["default", "a-*", "A-*", "n.*", "n-*", "(n-*)", "custom"].includes(normalizedCur);

    customFormatSetting = new Setting(container)
      .setName("Custom Pattern")
      .addText(text => {
        customInputEl = text.inputEl;
        text.setValue(isCustom ? cur : "A-*").onChange(async val => {
          await this.plugin.setFileFormat(path, val);
        });
        text.inputEl.addEventListener("change", async () => {
          if (isEnabled) {
            await this.plugin.updateNumberingForActiveFile();
          }
        });
      });
    customFormatSetting.settingEl.addClass("eqn-sidebar-setting-item");
    if (isCustom) {
      customFormatSetting.settingEl.show();
    } else {
      customFormatSetting.settingEl.hide();
    }

    const btnWrapper = container.createDiv({ cls: "eqn-sidebar-btn-wrapper" });
    const updateBtn = btnWrapper.createEl("button", {
      text: "Update",
      cls: "mod-cta eqn-sidebar-update-btn"
    });
    if (!isEnabled) {
      updateBtn.setAttribute("disabled", "true");
      updateBtn.addClass("eqn-btn-disabled");
    }
    updateBtn.addEventListener("click", () => {
      this.plugin.updateNumberingForActiveFile();
    });

    new Setting(container)
      .setName("Repeat Recognition")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.reuseNumberForDuplicates).onChange(async val => {
          this.plugin.settings.reuseNumberForDuplicates = val;
          await this.plugin.saveSettings();
          if (isEnabled) {
            await this.plugin.updateNumberingForActiveFile();
          }
        })
      )
      .settingEl.addClass("eqn-sidebar-setting-item");

    new Setting(container)
      .setName("Label Prefix")
      .addText(text =>
        text
          .setPlaceholder("eq:")
          .setValue(this.plugin.settings.labelPrefix !== undefined ? this.plugin.settings.labelPrefix : "eq:")
          .onChange(async val => {
            this.plugin.settings.labelPrefix = val;
            await this.plugin.saveSettings();
          })
      )
      .settingEl.addClass("eqn-sidebar-setting-item");

    new Setting(container)
      .setName("Suggest Count")
      .addText(text =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.suggestCount || 5))
          .onChange(async val => {
            const parsed = parseInt(val.trim(), 10);
            this.plugin.settings.suggestCount = !isNaN(parsed) && parsed > 0 ? parsed : 5;
            await this.plugin.saveSettings();
          })
      )
      .settingEl.addClass("eqn-sidebar-setting-item");

    let sidebarTemplateText: any = null;
    new Setting(container)
      .setName("Ref Format")
      .addDropdown(dropdown => {
        dropdown
          .addOption("chinese", "式（）")
          .addOption("eq", "Eq. ()")
          .addOption("equation", "Equation ()")
          .addOption("parens", "()")
          .addOption("custom", "自定义")
          .setValue(this.plugin.settings.referenceFormatType || "chinese")
          .onChange(async val => {
            this.plugin.settings.referenceFormatType = val as any;
            if (val === "chinese") {
              this.plugin.settings.referenceFormatTemplate = "式（）";
            } else if (val === "eq") {
              this.plugin.settings.referenceFormatTemplate = "Eq. ()";
            } else if (val === "equation") {
              this.plugin.settings.referenceFormatTemplate = "Equation ()";
            } else if (val === "parens") {
              this.plugin.settings.referenceFormatTemplate = "()";
            }
            if (sidebarTemplateText) {
              sidebarTemplateText.setValue(this.plugin.settings.referenceFormatTemplate);
            }
            await this.plugin.saveSettings();
          });
      })
      .addText(text => {
        sidebarTemplateText = text;
        text
          .setPlaceholder("式（） 或 Eq. () 或 xxx ()")
          .setValue(this.plugin.settings.referenceFormatTemplate || "式（）")
          .onChange(async val => {
            const trimmed = val.trim();
            this.plugin.settings.referenceFormatTemplate = trimmed || "式（）";
            if (
              trimmed !== "式（）" &&
              trimmed !== "Eq. ()" &&
              trimmed !== "Equation ()" &&
              trimmed !== "()"
            ) {
              this.plugin.settings.referenceFormatType = "custom";
            }
            await this.plugin.saveSettings();
          });
      })
      .settingEl.addClass("eqn-sidebar-setting-item");
  }
}

export interface EquationSuggestion {
  label: string;
  formula: string;
  tag?: string;
  offset: number;
}

export class EquationReferenceSuggest extends EditorSuggest<EquationSuggestion> {
  plugin: AutoEquationNumberingPlugin;

  constructor(app: App, plugin: AutoEquationNumberingPlugin) {
    super(app);
    this.plugin = plugin;
  }

  triggerSuggest(editor: Editor, file: TFile | null): void {
    try {
      if (typeof (this as any).trigger === "function") {
        (this as any).trigger(editor, file, true);
      }
    } catch (e) {
      console.error("Failed to trigger suggest:", e);
    }
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.substring(0, cursor.ch);

    // Matches e.g.:
    // [式（）](#f:
    // [式（）](eq:
    // [式（）](#eq:
    // [式（）](#f:dc
    // [式（）](#
    // [式（）](
    // [式 () ](#
    // (#f:
    // (eq:
    const regex = /(?:\[[^\]]*\])?\((#|\^)?(?:([^)\s\]]*:))?([^)\s\]]*)$/;
    const match = sub.match(regex);
    if (!match) return null;

    const hasAnchor = !!match[1];
    const hasColon = !!match[2];
    const rawPrefix = match[2] || ""; // e.g. "f:" or "eq:"
    const queryAfterColon = match[3] || "";

    const prefixOffset = (match[1] || "").length + rawPrefix.length + queryAfterColon.length;
    const isMarkdownLink = /(?:\[[^\]]*\])\($/.test(sub.substring(0, sub.length - prefixOffset));

    if (!hasAnchor && !hasColon && !isMarkdownLink) {
      return null;
    }

    const startCh = cursor.ch - prefixOffset;

    return {
      start: {
        line: cursor.line,
        ch: startCh
      },
      end: cursor,
      query: `${rawPrefix}|${queryAfterColon}`
    };
  }

  getSuggestions(context: EditorSuggestContext): EquationSuggestion[] {
    const content = context.editor.getValue();
    const cursorOffset = context.editor.posToOffset(context.start);

    let rawPrefix = "";
    let queryAfterColon = "";
    if (context.query && context.query.includes("|")) {
      const parts = context.query.split("|");
      rawPrefix = parts[0];
      queryAfterColon = parts[1];
    } else {
      queryAfterColon = context.query || "";
    }

    return this.plugin.getEquationSuggestions(content, cursorOffset, queryAfterColon, rawPrefix);
  }

  renderSuggestion(item: EquationSuggestion, el: HTMLElement): void {
    el.addClass("eqn-suggest-item");

    const headerEl = el.createDiv({ cls: "eqn-suggest-header" });
    headerEl.createSpan({ cls: "eqn-suggest-label", text: item.label });

    if (item.tag) {
      headerEl.createSpan({ cls: "eqn-suggest-tag", text: item.tag });
    }

    if (item.formula) {
      el.createDiv({ cls: "eqn-suggest-formula", text: item.formula });
    }
  }

  selectSuggestion(item: EquationSuggestion, evt: MouseEvent | KeyboardEvent): void {
    const { editor, start, end } = this.context;
    const line = editor.getLine(end.line);
    const after = line.substring(end.ch);

    const remainingMatch = after.match(/^[^)\s\]]*/);
    const remainingLen = remainingMatch ? remainingMatch[0].length : 0;

    const actualEnd: EditorPosition = {
      line: end.line,
      ch: end.ch + remainingLen
    };

    const textAfter = line.substring(actualEnd.ch);
    const hasClosingParen = textAfter.startsWith(")");

    const anchor = this.plugin.settings.anchorCharacter || "#";
    let replacement = `${anchor}${item.label}`;
    if (!hasClosingParen) {
      replacement += ")";
    }

    editor.replaceRange(replacement, start, actualEnd);

    const newCursorCh = start.ch + replacement.length + (hasClosingParen ? 1 : 0);
    editor.setCursor({
      line: start.line,
      ch: newCursorCh
    });
  }
}

export class EquationReferenceModal extends SuggestModal<EquationSuggestion> {
  plugin: AutoEquationNumberingPlugin;
  onChoose: (label: string) => void;

  constructor(app: App, plugin: AutoEquationNumberingPlugin, onChoose: (label: string) => void) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
    this.setPlaceholder("Select equation to reference... / 选择引用的公式...");
  }

  getSuggestions(query: string): EquationSuggestion[] {
    const activeView = this.plugin.getActiveMarkdownView();
    if (!activeView) return [];
    const content = activeView.editor.getValue();
    const cursor = activeView.editor.getCursor();
    const cursorOffset = activeView.editor.posToOffset(cursor);

    return this.plugin.getEquationSuggestions(content, cursorOffset, query, "");
  }

  renderSuggestion(item: EquationSuggestion, el: HTMLElement): void {
    el.addClass("eqn-suggest-item");

    const headerEl = el.createDiv({ cls: "eqn-suggest-header" });
    headerEl.createSpan({ cls: "eqn-suggest-label", text: item.label });

    if (item.tag) {
      headerEl.createSpan({ cls: "eqn-suggest-tag", text: item.tag });
    }

    if (item.formula) {
      el.createDiv({ cls: "eqn-suggest-formula", text: item.formula });
    }
  }

  onChooseSuggestion(item: EquationSuggestion, evt: MouseEvent | KeyboardEvent): void {
    this.onChoose(item.label);
  }
}

export default class AutoEquationNumberingPlugin extends Plugin {
  settings: EquationNumberingSettings = DEFAULT_SETTINGS;
  private applying = new Set<string>();
  statusBarItem!: HTMLElement;
  sidebarView: EquationNumberingView | null = null;
  lastActiveMarkdownView: MarkdownView | null = null;
  referenceSuggest!: EquationReferenceSuggest;
  lastKnownLabels: Set<string> = new Set<string>();
  recentlyCreatedLabels: string[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new EquationNumberingSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_EQUATION_NUMBERING,
      (leaf) => new EquationNumberingView(leaf, this)
    );

    this.referenceSuggest = new EquationReferenceSuggest(this.app, this);
    this.registerEditorSuggest(this.referenceSuggest);

    // Track recently created or edited labels in real time
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
        try {
          const content = editor.getValue();
          const mathRegex = /\$\$([\s\S]*?)\$\$/g;
          let m: RegExpExecArray | null;
          const currentLabels = new Set<string>();
          while ((m = mathRegex.exec(content)) !== null) {
            const lm = m[1].match(/(?:%\s*)?\\label\s*\{([^{}]+)\}/);
            if (lm) currentLabels.add(lm[1].trim());
          }
          for (const lbl of currentLabels) {
            if (!this.lastKnownLabels.has(lbl)) {
              this.recentlyCreatedLabels = [lbl, ...this.recentlyCreatedLabels.filter(x => x !== lbl)].slice(0, 20);
            }
          }
          this.lastKnownLabels = currentLabels;
        } catch (e) {
          // ignore
        }
      })
    );

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("equation-numbering-status-bar");
    this.statusBarItem.addEventListener("click", () => {
      const activeView = this.getActiveMarkdownView();
      if (!activeView || !activeView.file) {
        new Notice("Open a Markdown note first.");
        return;
      }
      const path = activeView.file.path;
      const fileSettings = this.getFileSettings(path);
      (async () => {
        if (!fileSettings.enabled) {
          await this.setFileEnabled(path, true);
          new Notice("Equation numbering enabled for this note.");
          this.updateStatusBar();
          if (this.sidebarView) this.sidebarView.updateView();
        }
        await this.updateNumberingForActiveFile();
      })().catch(err => {
        console.error("Failed to update numbering from status bar:", err);
      });
    });

    this.addRibbonIcon("list-ordered", "Equation Numbering Control Panel", async () => {
      await this.activateView();
    });

    this.addRibbonIcon("refresh-cw", "Update Equation Numbers (UpNum)", async () => {
      const activeView = this.getActiveMarkdownView();
      if (!activeView || !activeView.file) {
        new Notice("Open a Markdown note first.");
        return;
      }
      const path = activeView.file.path;
      const fileSettings = this.getFileSettings(path);
      if (!fileSettings.enabled) {
        await this.setFileEnabled(path, true);
        new Notice("Equation numbering enabled for this note.");
        this.updateStatusBar();
        if (this.sidebarView) this.sidebarView.updateView();
      }
      await this.updateNumberingForActiveFile();
    });

    this.addCommand({
      id: "open-equation-numbering-sidebar",
      name: "Open Equation Numbering control panel (Sidebar)",
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: "toggle-equation-numbering",
      name: "Toggle Equation Numbering (Open/Close Number) for current note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.toggleNumberingForActiveFile();
        if (this.sidebarView) this.sidebarView.updateView();
      }
    });

    this.addCommand({
      id: "update-equation-numbers",
      name: "Update Equation Numbers in current note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.updateNumberingForActiveFile();
      }
    });

    this.addCommand({
      id: "renumber-vault",
      name: "Renumber display equations in all enabled Markdown notes",
      callback: async () => {
        await this.renumberVault();
      }
    });

    this.addCommand({
      id: "insert-equation-label",
      name: "Insert equation label (% \\label{prefix})",
      editorCallback: (editor: Editor) => {
        const cursor = editor.getCursor();
        const prefix = this.settings.labelPrefix !== undefined ? this.settings.labelPrefix : "eq:";
        const snippet = `% \\label{${prefix}}`;
        editor.replaceRange(snippet, cursor);
        editor.setCursor({
          line: cursor.line,
          ch: cursor.ch + `% \\label{${prefix}`.length
        });
      }
    });

    this.addCommand({
      id: "insert-equation-reference",
      name: "Insert equation reference link ([式（）](#prefix))",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const cursor = editor.getCursor();
        const anchor = this.settings.anchorCharacter || "#";
        const prefix = this.settings.labelPrefix !== undefined ? this.settings.labelPrefix : "eq:";
        const template = this.settings.referenceFormatTemplate || "式（）";
        const snippet = `[${template}](${anchor}${prefix})`;
        editor.replaceRange(snippet, cursor);
        const targetCursor = {
          line: cursor.line,
          ch: cursor.ch + `[${template}](${anchor}${prefix}`.length
        };
        editor.setCursor(targetCursor);

        // Automatically trigger suggestion popup
        window.setTimeout(() => {
          try {
            if (this.referenceSuggest) {
              this.referenceSuggest.triggerSuggest(editor, view?.file || null);
            }
            if ((this.app.workspace as any).editorSuggest?.trigger) {
              (this.app.workspace as any).editorSuggest.trigger(editor, view?.file || null, true);
            }
          } catch (e) {
            console.error("Trigger suggest error:", e);
          }
        }, 30);
      }
    });

    this.addCommand({
      id: "insert-equation-reference-modal",
      name: "Insert equation reference from modal picker",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        new EquationReferenceModal(this.app, this, (selectedLabel) => {
          const anchor = this.settings.anchorCharacter || "#";
          const template = this.settings.referenceFormatTemplate || "式（）";
          const snippet = `[${template}](${anchor}${selectedLabel})`;
          editor.replaceSelection(snippet);
        }).open();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateStatusBar();
        if (this.sidebarView) this.sidebarView.updateView();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.sidebarView) this.sidebarView.updateView();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (this.settings.enabledFiles && this.settings.enabledFiles[oldPath]) {
          this.settings.enabledFiles[file.path] = this.settings.enabledFiles[oldPath];
          delete this.settings.enabledFiles[oldPath];
          await this.saveSettings();
          this.updateStatusBar();
          if (this.sidebarView) this.sidebarView.updateView();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (this.settings.enabledFiles && this.settings.enabledFiles[file.path]) {
          delete this.settings.enabledFiles[file.path];
          await this.saveSettings();
          this.updateStatusBar();
          if (this.sidebarView) this.sidebarView.updateView();
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.lastActiveMarkdownView = activeView;
      }
      this.updateStatusBar();
    });
  }

  getEquationSuggestions(
    content: string,
    cursorOffset: number | null,
    queryAfterColon: string,
    rawPrefix: string
  ): EquationSuggestion[] {
    const query = (queryAfterColon || "").toLowerCase().trim();
    const typedPrefix = (rawPrefix || "").toLowerCase().trim();

    const list: EquationSuggestion[] = [];
    const seenLabels = new Set<string>();
    const currentLabelsInDoc = new Set<string>();

    const mathRegex = /\$\$([\s\S]*?)\$\$/g;
    let m: RegExpExecArray | null;

    while ((m = mathRegex.exec(content)) !== null) {
      const body = m[1];
      const offset = m.index;

      const labelMatch = body.match(/(?:%\s*)?\\label\s*\{([^{}]+)\}/);
      if (!labelMatch) continue;

      const label = labelMatch[1].trim();
      if (!label || seenLabels.has(label)) continue;
      seenLabels.add(label);
      currentLabelsInDoc.add(label);

      const tagMatch = body.match(/\\tag\s*\{([^{}]+)\}/);
      const tag = tagMatch ? tagMatch[1].trim() : undefined;

      const cleanFormula = body
        .replace(/(?:%\s*)?\\label\s*\{[^{}]*\}/g, "")
        .replace(/\\tag\s*\{[^{}]*\}/g, "")
        .replace(/\r?\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      list.push({
        label,
        formula: cleanFormula,
        tag,
        offset
      });
    }

    // Register newly detected labels into recentlyCreatedLabels
    for (const lbl of currentLabelsInDoc) {
      if (!this.lastKnownLabels.has(lbl)) {
        this.recentlyCreatedLabels = [lbl, ...this.recentlyCreatedLabels.filter(x => x !== lbl)];
      }
    }
    this.recentlyCreatedLabels = this.recentlyCreatedLabels.filter(lbl => currentLabelsInDoc.has(lbl));
    if (this.recentlyCreatedLabels.length > 20) {
      this.recentlyCreatedLabels = this.recentlyCreatedLabels.slice(0, 20);
    }
    this.lastKnownLabels = currentLabelsInDoc;

    // Scan referenced labels in markdown links (excluding the active link being typed)
    const referencedLabels = new Set<string>();
    const refRegex = /(?:\[[^\]]*\])?\((?:#|\^)?([^)\s\]]+)\)/g;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = refRegex.exec(content)) !== null) {
      if (cursorOffset !== null && Math.abs(refMatch.index - cursorOffset) < 50 && refMatch[1].endsWith(":")) {
        continue;
      }
      const refTarget = refMatch[1].trim();
      referencedLabels.add(refTarget);
      const colonIdx = refTarget.indexOf(":");
      if (colonIdx !== -1) {
        referencedLabels.add(refTarget.substring(colonIdx + 1));
      }
    }

    const sortMode = this.settings.suggestSortMode || "smart";

    if (sortMode === "bottom_up") {
      list.sort((a, b) => b.offset - a.offset);
    } else if (sortMode === "cursor") {
      if (cursorOffset !== null) {
        list.sort((a, b) => {
          const aBefore = a.offset <= cursorOffset;
          const bBefore = b.offset <= cursorOffset;
          if (aBefore && !bBefore) return -1;
          if (!aBefore && bBefore) return 1;
          if (aBefore && bBefore) {
            return (cursorOffset - a.offset) - (cursorOffset - b.offset);
          }
          return (a.offset - cursorOffset) - (b.offset - cursorOffset);
        });
      } else {
        list.sort((a, b) => b.offset - a.offset);
      }
    } else if (sortMode === "recent_edit") {
      list.sort((a, b) => {
        const aRecentIdx = this.recentlyCreatedLabels.indexOf(a.label);
        const bRecentIdx = this.recentlyCreatedLabels.indexOf(b.label);
        const aScore = aRecentIdx !== -1 ? aRecentIdx : 9999;
        const bScore = bRecentIdx !== -1 ? bRecentIdx : 9999;
        if (aScore !== bScore) return aScore - bScore;
        return b.offset - a.offset;
      });
    } else {
      // "smart" mode: Tier 1 (recently created) -> Tier 2 (unreferenced) -> Tier 3 (cursor proximity) -> Tier 4 (bottom up)
      list.sort((a, b) => {
        // 1. Recently edited / created in session
        const aRecentIdx = this.recentlyCreatedLabels.indexOf(a.label);
        const bRecentIdx = this.recentlyCreatedLabels.indexOf(b.label);
        const aIsRecent = aRecentIdx !== -1;
        const bIsRecent = bRecentIdx !== -1;
        if (aIsRecent && !bIsRecent) return -1;
        if (!aIsRecent && bIsRecent) return 1;
        if (aIsRecent && bIsRecent && aRecentIdx !== bRecentIdx) {
          return aRecentIdx - bRecentIdx;
        }

        // 2. Unreferenced in document
        const aIsUnref = !referencedLabels.has(a.label) && !referencedLabels.has(a.label.replace(/^[^:]*:/, ""));
        const bIsUnref = !referencedLabels.has(b.label) && !referencedLabels.has(b.label.replace(/^[^:]*:/, ""));
        if (aIsUnref && !bIsUnref) return -1;
        if (!aIsUnref && bIsUnref) return 1;

        // 3. Proximity to cursor (closest preceding cursor first)
        if (cursorOffset !== null) {
          const aBefore = a.offset <= cursorOffset;
          const bBefore = b.offset <= cursorOffset;
          if (aBefore && !bBefore) return -1;
          if (!aBefore && bBefore) return 1;
          if (aBefore && bBefore) {
            return (cursorOffset - a.offset) - (cursorOffset - b.offset);
          }
          return (a.offset - cursorOffset) - (b.offset - cursorOffset);
        }

        // 4. Reverse document order
        return b.offset - a.offset;
      });
    }

    let filtered = list;
    if (query.length > 0) {
      filtered = list.filter(item => {
        const lbl = item.label.toLowerCase();
        const colonIdx = lbl.indexOf(":");
        const namePart = colonIdx !== -1 ? lbl.substring(colonIdx + 1) : lbl;
        return lbl.includes(query) || namePart.includes(query);
      });
      filtered.sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(query);
        const bStarts = b.label.toLowerCase().startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return 0;
      });
    }

    if (typedPrefix.length > 0) {
      filtered.sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(typedPrefix);
        const bStarts = b.label.toLowerCase().startsWith(typedPrefix);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return 0;
      });
    }

    const maxCount = Math.max(1, this.settings.suggestCount || 5);
    return filtered.slice(0, maxCount);
  }

  onunload(): void {}

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.enabledFiles) {
      this.settings.enabledFiles = {};
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getActiveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      this.lastActiveMarkdownView = active;
      return active;
    }
    if (this.lastActiveMarkdownView && this.app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === this.lastActiveMarkdownView)) {
      return this.lastActiveMarkdownView;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    if (leaves.length > 0) {
      const view = leaves[0].view as MarkdownView;
      this.lastActiveMarkdownView = view;
      return view;
    }
    return null;
  }

  getFileSettings(path: string): FileSettings {
    if (!this.settings.enabledFiles) {
      this.settings.enabledFiles = {};
    }
    const val = this.settings.enabledFiles[path];
    if (typeof val === "boolean") {
      return { enabled: val, format: "default", chapterMode: false };
    }
    if (val) {
      return {
        enabled: !!val.enabled,
        format: val.format || "default",
        chapterMode: val.chapterMode !== undefined ? val.chapterMode : false
      };
    }
    return { enabled: false, format: "default", chapterMode: false };
  }

  async setFileEnabled(path: string, enabled: boolean): Promise<void> {
    const current = this.getFileSettings(path);
    this.settings.enabledFiles[path] = { ...current, enabled };
    await this.saveSettings();
  }

  async setFileFormat(path: string, format: string): Promise<void> {
    const current = this.getFileSettings(path);
    this.settings.enabledFiles[path] = { ...current, format };
    await this.saveSettings();
  }

  async setFileChapterMode(path: string, chapterMode: boolean | string): Promise<void> {
    const current = this.getFileSettings(path);
    this.settings.enabledFiles[path] = { ...current, chapterMode };
    await this.saveSettings();
  }

  async toggleNumberingForActiveFile(): Promise<void> {
    const activeView = this.getActiveMarkdownView();
    if (!activeView || !activeView.file) {
      new Notice("Open a Markdown note first.");
      return;
    }
    const path = activeView.file.path;
    const current = this.getFileSettings(path);
    const willEnable = !current.enabled;
    await this.setFileEnabled(path, willEnable);

    this.updateStatusBar();
    if (this.sidebarView) {
      this.sidebarView.updateView();
    }

    if (willEnable) {
      await this.renumberEditor(activeView.editor, activeView.file);
      new Notice("Equation numbering enabled and updated.");
    } else {
      new Notice("Equation numbering disabled for this note.");
    }
  }

  async updateNumberingForActiveFile(): Promise<void> {
    const activeView = this.getActiveMarkdownView();
    if (!activeView || !activeView.file) {
      new Notice("Open a Markdown note first.");
      return;
    }
    await this.renumberEditor(activeView.editor, activeView.file);
    new Notice("Equation numbers updated.");
  }

  updateStatusBar(): void {
    if (!this.statusBarItem) return;
    const activeView = this.getActiveMarkdownView();
    if (!activeView || !activeView.file) {
      this.statusBarItem.setText("🔢 UpNum");
      this.statusBarItem.addClass("is-inactive");
      this.statusBarItem.removeClass("is-active");
      this.statusBarItem.setAttribute("title", "Update Equation Numbers (UpNum)");
      return;
    }
    const current = this.getFileSettings(activeView.file.path);
    this.statusBarItem.setText("🔢 UpNum");
    if (current.enabled) {
      this.statusBarItem.addClass("is-active");
      this.statusBarItem.removeClass("is-inactive");
      this.statusBarItem.setAttribute("title", "Update Equation Numbers (UpNum)");
    } else {
      this.statusBarItem.addClass("is-inactive");
      this.statusBarItem.removeClass("is-active");
      this.statusBarItem.setAttribute("title", "Enable & Update Equation Numbers (UpNum)");
    }
  }

  async renumberEditor(editor: Editor, file: TFile | null): Promise<void> {
    if (!file || this.applying.has(file.path)) return;

    const path = file.path;
    const fileSettings = this.getFileSettings(path);
    const format = fileSettings.format || "default";
    const chapterMode = fileSettings.chapterMode !== undefined ? fileSettings.chapterMode : false;

    const original = editor.getValue();
    const result = renumberText(
      original,
      this.settings.reuseNumberForDuplicates,
      format,
      this.settings.anchorCharacter,
      chapterMode,
      this.settings.unifyReferenceFormat,
      this.settings.referenceFormatTemplate
    );
    if (result.text === original) return;

    this.applying.add(file.path);
    try {
      const diff = getDiffRange(original, result.text);
      if (diff) {
        const fromPos = editor.offsetToPos(diff.from);
        const toPos = editor.offsetToPos(diff.to);
        editor.replaceRange(diff.text, fromPos, toPos);
      }
    } finally {
      window.setTimeout(() => this.applying.delete(file.path), 0);
    }
  }

  private async renumberVault(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let changed = 0;

    for (const file of files) {
      const fileSettings = this.getFileSettings(file.path);
      if (!fileSettings.enabled) continue;

      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const openView = leaves.find(l => (l.view as MarkdownView).file?.path === file.path)?.view as MarkdownView;
      if (openView) {
        const before = openView.editor.getValue();
        await this.renumberEditor(openView.editor, file);
        if (openView.editor.getValue() !== before) changed += 1;
        continue;
      }

      const before = await this.app.vault.read(file);
      const result = renumberText(
        before,
        this.settings.reuseNumberForDuplicates,
        fileSettings.format || "default",
        this.settings.anchorCharacter,
        fileSettings.chapterMode !== undefined ? fileSettings.chapterMode : false,
        this.settings.unifyReferenceFormat,
        this.settings.referenceFormatTemplate
      );
      if (result.text !== before) {
        await this.app.vault.modify(file, result.text);
        changed += 1;
      }
    }

    new Notice(`Equation numbering updated in ${changed} note(s).`);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_EQUATION_NUMBERING);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_EQUATION_NUMBERING,
          active: true
        });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}

class EquationNumberingSettingTab extends PluginSettingTab {
  plugin: AutoEquationNumberingPlugin;

  constructor(app: App, plugin: AutoEquationNumberingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Reuse number for duplicate equations")
      .setDesc("When enabled, identical display equations will share the same equation number.")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.reuseNumberForDuplicates).onChange(async val => {
          this.plugin.settings.reuseNumberForDuplicates = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Anchor character")
      .setDesc("Prefix character used for internal equation links, e.g. '#' in [Eq. (1)](#eq:label).")
      .addText(text =>
        text
          .setPlaceholder("#")
          .setValue(this.plugin.settings.anchorCharacter)
          .onChange(async val => {
            this.plugin.settings.anchorCharacter = val.trim() || "#";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Equation label prefix")
      .setDesc("Default prefix for equation labels (e.g. 'eq:' or 'f:'). Default is 'eq:'.")
      .addText(text =>
        text
          .setPlaceholder("eq:")
          .setValue(this.plugin.settings.labelPrefix || "eq:")
          .onChange(async val => {
            this.plugin.settings.labelPrefix = val.trim() || "eq:";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Number of label suggestions")
      .setDesc("Maximum number of recent equation labels to display in the autocomplete popup (default: 5).")
      .addText(text =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.suggestCount || 5))
          .onChange(async val => {
            const parsed = parseInt(val.trim(), 10);
            this.plugin.settings.suggestCount = !isNaN(parsed) && parsed > 0 ? parsed : 5;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Candidate suggestion sorting mode / 候选公式排序规则")
      .setDesc("Sorting strategy for equation candidates in the autocomplete popup / 自动完成弹窗中候选公式的排序策略")
      .addDropdown(dropdown =>
        dropdown
          .addOption("smart", "智能推荐 (Smart: 新增/未引用/光标就近)")
          .addOption("cursor", "光标就近 (Cursor: 自光标向上优先)")
          .addOption("recent_edit", "最近编辑 (Recent edit: 最新编辑的标签优先)")
          .addOption("bottom_up", "文档末尾 (Bottom-up: 纯文档自底向上)")
          .setValue(this.plugin.settings.suggestSortMode || "smart")
          .onChange(async val => {
            this.plugin.settings.suggestSortMode = val as any;
            await this.plugin.saveSettings();
          })
      );

    let tabTemplateText: any = null;
    new Setting(containerEl)
      .setName("Equation reference template / 正文公式引用模板")
      .setDesc("Template format for in-text equation references (e.g. 'Eq. ()', 'Equation ()', '()', '式（）', or custom 'xxx ()') / 正文中插入和格式化公式引用的模板样式")
      .addDropdown(dropdown => {
        dropdown
          .addOption("chinese", "式（） (中文默认: 式（1）)")
          .addOption("eq", "Eq. () (英文标准: Eq. (1))")
          .addOption("equation", "Equation () (英文全称: Equation (1))")
          .addOption("parens", "() (纯括号: (1))")
          .addOption("custom", "自定义 (Custom: 例如 xxx ())")
          .setValue(this.plugin.settings.referenceFormatType || "chinese")
          .onChange(async val => {
            this.plugin.settings.referenceFormatType = val as any;
            if (val === "chinese") {
              this.plugin.settings.referenceFormatTemplate = "式（）";
            } else if (val === "eq") {
              this.plugin.settings.referenceFormatTemplate = "Eq. ()";
            } else if (val === "equation") {
              this.plugin.settings.referenceFormatTemplate = "Equation ()";
            } else if (val === "parens") {
              this.plugin.settings.referenceFormatTemplate = "()";
            }
            if (tabTemplateText) {
              tabTemplateText.setValue(this.plugin.settings.referenceFormatTemplate);
            }
            await this.plugin.saveSettings();
          });
      })
      .addText(text => {
        tabTemplateText = text;
        text
          .setPlaceholder("式（） 或 Eq. () 或 xxx ()")
          .setValue(this.plugin.settings.referenceFormatTemplate || "式（）")
          .onChange(async val => {
            const trimmed = val.trim();
            this.plugin.settings.referenceFormatTemplate = trimmed || "式（）";
            if (
              trimmed !== "式（）" &&
              trimmed !== "Eq. ()" &&
              trimmed !== "Equation ()" &&
              trimmed !== "()"
            ) {
              this.plugin.settings.referenceFormatType = "custom";
            }
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Unify existing reference formats / 统一现有引用前缀格式")
      .setDesc("When updating, standardize all existing references in the note to match the template above instead of keeping their individual existing prefixes. / 更新时将正文中所有已有引用的前缀统一转换为上方选定的模板样式（如将已有的 [式（1）] 统一替换为 [Eq. (1)] 或 [xxx (1)]），而不是保留各自原有的前缀。")
      .addToggle(toggle =>
        toggle
          .setValue(!!this.plugin.settings.unifyReferenceFormat)
          .onChange(async val => {
            this.plugin.settings.unifyReferenceFormat = val;
            await this.plugin.saveSettings();
          })
      );

    // Interactive Demo Card
    const demoContainer = containerEl.createDiv({ cls: "eqn-demo-container" });
    demoContainer.createDiv({ cls: "setting-item-heading eqn-demo-title", text: "✨ 功能演示 (Demonstration)" });
    demoContainer.createDiv({
      cls: "setting-item-description eqn-demo-subtitle",
      text: "以下演示展示了插件的核心自动化行为：自动追加编号标签与正文交叉引用智能同步。"
    });

    const card1 = demoContainer.createDiv({ cls: "eqn-demo-card" });
    card1.createDiv({ cls: "eqn-demo-card-title", text: "1. 自动追加公式编号" });
    const flow1 = card1.createDiv({ cls: "eqn-demo-flow" });
    const stepWrapper1 = flow1.createDiv({ cls: "eqn-demo-step-wrapper" });

    const step1Before = stepWrapper1.createDiv({ cls: "eqn-demo-step-box" });
    const headerBefore1 = step1Before.createDiv({ cls: "eqn-demo-step-header" });
    headerBefore1.createDiv({ cls: "eqn-demo-step-label", text: "编辑中" });
    headerBefore1.createDiv({ cls: "eqn-demo-badge eqn-demo-badge-before", text: "BEFORE" });
    step1Before.createEl("pre", {
      cls: "eqn-demo-step-code",
      text: `$$\n\\hat{\\boldsymbol{y}}_c = \\boldsymbol{X}_c\\hat{\\boldsymbol{\\beta}}\n$$`
    });

    stepWrapper1.createDiv({ cls: "eqn-demo-arrow-box" }).createDiv({ cls: "eqn-demo-arrow-icon", text: "➡️" });

    const step1After = stepWrapper1.createDiv({ cls: "eqn-demo-step-box" });
    const headerAfter1 = step1After.createDiv({ cls: "eqn-demo-step-header" });
    headerAfter1.createDiv({ cls: "eqn-demo-step-label", text: "自动更新后" });
    headerAfter1.createDiv({ cls: "eqn-demo-badge eqn-demo-badge-after", text: "AFTER" });
    const preAfter1 = step1After.createEl("pre", { cls: "eqn-demo-step-code" });
    preAfter1.createSpan({ text: `$$\n\\hat{\\boldsymbol{y}}_c = \\boldsymbol{X}_c\\hat{\\boldsymbol{\\beta}}\n` });
    preAfter1.createSpan({ text: "\\tag{1}", cls: "eqn-demo-green-highlight" });
    preAfter1.createSpan({ text: "\n$$" });

    const card2 = demoContainer.createDiv({ cls: "eqn-demo-card" });
    card2.createDiv({ cls: "eqn-demo-card-title", text: "2. 交叉引用同步" });
    const flow2 = card2.createDiv({ cls: "eqn-demo-flow" });
    const stepWrapper2 = flow2.createDiv({ cls: "eqn-demo-step-wrapper" });

    const step2Before = stepWrapper2.createDiv({ cls: "eqn-demo-step-box" });
    const headerBefore2 = step2Before.createDiv({ cls: "eqn-demo-step-header" });
    headerBefore2.createDiv({ cls: "eqn-demo-step-label", text: "编辑中" });
    headerBefore2.createDiv({ cls: "eqn-demo-badge eqn-demo-badge-before", text: "BEFORE" });
    step2Before.createEl("pre", {
      cls: "eqn-demo-step-code",
      text: `$$\ny_i = \\beta_0 + \\sum_{j=1}^p \\beta_j x_{ij} + \\varepsilon_i\n\\label{eq:mlr}\n$$\n\n如[式（）](#eq:mlr)所示，我们建立了多元线性回归模型。`
    });

    stepWrapper2.createDiv({ cls: "eqn-demo-arrow-box" }).createDiv({ cls: "eqn-demo-arrow-icon", text: "➡️" });

    const step2After = stepWrapper2.createDiv({ cls: "eqn-demo-step-box" });
    const headerAfter2 = step2After.createDiv({ cls: "eqn-demo-step-header" });
    headerAfter2.createDiv({ cls: "eqn-demo-step-label", text: "更新后" });
    headerAfter2.createDiv({ cls: "eqn-demo-badge eqn-demo-badge-after", text: "AFTER" });
    const preAfter2 = step2After.createEl("pre", { cls: "eqn-demo-step-code" });
    preAfter2.createSpan({ text: `$$\ny_i = \\beta_0 + \\sum_{j=1}^p \\beta_j x_{ij} + \\varepsilon_i\n% \\label{eq:mlr}\n` });
    preAfter2.createSpan({ text: "\\tag{1}", cls: "eqn-demo-green-highlight" });
    preAfter2.createSpan({ text: "\n$$\n\n如" });
    preAfter2.createSpan({ text: "[式（1）](#eq:mlr)", cls: "eqn-demo-green-highlight" });
    preAfter2.createSpan({ text: "所示，我们建立了多元线性回归模型。" });

    const tip2 = card2.createDiv({ cls: "eqn-demo-tip" });
    tip2.createSpan({ text: "💡 提示：", cls: "eqn-demo-highlight" });
    tip2.createSpan({ text: "若在当前公式前插入其他公式导致其编号变为 " });
    tip2.createSpan({ text: "2", cls: "eqn-demo-highlight" });
    tip2.createSpan({ text: "，再次触发更新后，正文中的引用链接将自动同步更新为：" });
    tip2.createEl("code", { text: "[式（2）](#eq:mlr)" });
    tip2.createSpan({ text: "。" });
  }
}
