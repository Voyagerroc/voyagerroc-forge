// A very small DOM for running public/app.js inside node:vm. querySelector hands out one element
// per selector. getElementById and focus are real: an element is connected when it hangs below one
// of those root elements, so a test can tell a re-rendered control from a stale one.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = new Map(); this.className = ''; this.parentElement = null; }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get value() { return this._value ?? (this.tagName === 'select' ? this.children[0]?.value : this.textContent) ?? ''; }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  get isConnected() { let el = this; while (el) { if (el._root) return true; el = el.parentElement; } return false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }
  prepend(...children) { children.forEach(child => { child.parentElement = this; }); this.children.unshift(...children); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = [];
    this.append(...children);
    if (this.tagName === 'select') this._value = children[0]?.value ?? '';
  }
  before(child) { child.parentElement = this.parentElement; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child); }
  remove() { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  click() { this.clicked = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { if (this.isConnected && this._document) this._document.activeElement = this; }
  scrollIntoView() {}
}

// Depth-first search helpers for assertions.
export const walk = (root, visit) => { visit(root); root.children.forEach(child => walk(child, visit)); };
export const all = (root, test) => { const found = []; walk(root, el => { if (test(el)) found.push(el); }); return found; };
export const withClass = (root, name) => all(root, el => String(el.className).split(/\s+/).includes(name));
export const textOf = el => [el.textContent ?? '', ...el.children.map(textOf)].join(' ').replace(/\s+/g, ' ').trim();

export function loadApp({ selectTags = ['#project', '#filter-project', '#adapter'], extra = {} } = {}) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) { const el = new Element(selectTags.includes(selector) ? 'select' : 'div'); el._root = true; el._document = document; elements.set(selector, el); }
    return elements.get(selector);
  };
  const find = (root, id) => { if (root.id === id) return root; for (const child of root.children) { const hit = find(child, id); if (hit) return hit; } return null; };
  const document = {
    body: new Element('body'), activeElement: null,
    // Only a dialog that was really opened with showModal() counts as open.
    querySelector: selector => selector === 'dialog[open]' ? ([...elements.values()].find(el => el.open === true) ?? null) : get(selector),
    getElementById: id => { for (const root of elements.values()) { const hit = find(root, id); if (hit) return hit; } return null; },
    createElement: tag => { const el = new Element(tag); el._document = document; return el; }
  };
  const context = vm.createContext({ document, fetch: () => new Promise(() => {}), setInterval: () => {}, setTimeout: () => 0, ...extra });
  vm.runInContext(readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'), context);
  return { context, document, get, elements };
}
