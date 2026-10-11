// The source list beside Explore and Search results: a vertical, filterable list grouped into media
// servers and sites, so it stays usable with many sources. Narrow windows get a dropdown instead.
import type { SiteConfig } from '@onidoku/core';
import { h } from './dom';
import { nsfwTag, sourceIcon } from './ui';

export interface PickerEntry {
  config: SiteConfig;
  /** Shown after the name: a result count, a spinner, an alert. */
  extra?: Node;
  /** The source failed or lacks access: listed after the ones that work. */
  failing?: boolean;
}

/** Above this many sources the list gets a filter box. */
const FILTER_FROM = 7;

export class SourcePicker {
  readonly el: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly select: HTMLSelectElement;
  private readonly list: HTMLElement;
  private entries: PickerEntry[] = [];
  private selected = '';

  constructor(
    label: string,
    private readonly onSelect: (id: string) => void,
  ) {
    this.filter = h('input', { type: 'search', class: 'picker-filter', placeholder: 'filter sources', 'aria-label': 'filter sources', autocomplete: 'off' });
    this.filter.addEventListener('input', () => this.renderList());
    this.select = h('select', { class: 'picker-select', 'aria-label': label });
    this.select.addEventListener('change', () => this.pick(this.select.value));
    this.list = h('div', { class: 'picker-list', role: 'tablist', 'aria-label': label, 'aria-orientation': 'vertical' });
    this.list.addEventListener('keydown', (event) => this.onKey(event));
    this.el = h('nav', { class: 'source-picker', 'aria-label': label }, this.select, this.filter, this.list);
  }

  update(entries: PickerEntry[], selected: string): void {
    // By name, then the working sources ahead of the failing ones (the sort is stable).
    this.entries = [...entries]
      .sort((a, b) => a.config.name.localeCompare(b.config.name, undefined, { sensitivity: 'base', numeric: true }))
      .sort((a, b) => Number(Boolean(a.failing)) - Number(Boolean(b.failing)));
    this.selected = selected;
    this.filter.hidden = entries.length < FILTER_FROM;
    this.renderSelect();
    this.renderList();
  }

  /** Reports every pick, even of the selected source: on Search that pins a source chosen automatically. */
  private pick(id: string): void {
    if (id) this.onSelect(id);
  }

  /** Media servers first (the user's own collection), then sites; headings only when both exist. */
  private groups(entries: PickerEntry[]): [string, PickerEntry[]][] {
    const servers = entries.filter((e) => e.config.server);
    const sites = entries.filter((e) => !e.config.server);
    if (!servers.length || !sites.length) return [['', entries]];
    return [['media servers', servers], ['sites', sites]];
  }

  private renderSelect(): void {
    this.select.replaceChildren(
      ...this.groups(this.entries).map(([name, entries]) => {
        const options = entries.map((e) => {
          const name = e.config.nsfw ? `${e.config.name} · 18+` : e.config.name;
          const text = e.extra?.textContent ? `${name} (${e.extra.textContent})` : name;
          return h('option', { value: e.config.id, text });
        });
        return h('optgroup', { label: name || 'sources' }, ...options);
      }),
    );
    this.select.value = this.selected;
  }

  private renderList(): void {
    // Re-rendering replaces the buttons: keep keyboard focus on the selected one.
    const hadFocus = this.list.contains(document.activeElement);
    const needle = this.filter.value.trim().toLowerCase();
    const shown = needle ? this.entries.filter((e) => e.config.name.toLowerCase().includes(needle)) : this.entries;
    if (!shown.length) {
      this.list.replaceChildren(h('p', { class: 'hint picker-empty', text: 'no sources match.' }));
      return;
    }
    this.list.replaceChildren(
      ...this.groups(shown).flatMap(([name, entries]) => [
        name ? h('p', { class: 'picker-group', text: name }) : undefined,
        ...entries.map((e) => this.item(e)),
      ]).filter((el): el is HTMLElement => Boolean(el)),
    );
    if (hadFocus) this.list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  private item({ config, extra }: PickerEntry): HTMLElement {
    const selected = config.id === this.selected;
    const el = h(
      'button',
      { type: 'button', role: 'tab', class: 'picker-item', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', 'data-id': config.id, title: config.name },
      sourceIcon(config, 20),
      h('span', { class: 'picker-name', text: config.name }),
      config.nsfw ? nsfwTag() : undefined,
      extra,
    );
    el.addEventListener('click', () => this.pick(config.id));
    return el;
  }

  /** Arrow keys move through the list, like any vertical tab list. */
  private onKey(event: KeyboardEvent): void {
    const items = Array.from(this.list.querySelectorAll<HTMLButtonElement>('.picker-item'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      event.key === 'ArrowDown' ? items[Math.min(index + 1, items.length - 1)]
      : event.key === 'ArrowUp' ? items[Math.max(index - 1, 0)]
      : event.key === 'Home' ? items[0]
      : event.key === 'End' ? items.at(-1)
      : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
    this.pick(target.dataset.id!);
  }
}
