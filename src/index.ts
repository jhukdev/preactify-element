import { h, render, ComponentFactory, FunctionComponent, ComponentType } from 'preact';
import Markup from 'preact-markup';

/* -----------------------------------
 *
 * Types
 *
 * -------------------------------- */

type ComponentFunction<P = {}> = () => ComponentResult<P>;
type ComponentResult<P = {}> = ComponentFactory<P> | ComponentAsync<P>;
type ComponentAsync<P = {}> =
  | Promise<ComponentFactory<P>>
  | Promise<{ [index: string]: ComponentFactory<P> }>;

/* -----------------------------------
 *
 * Options
 *
 * -------------------------------- */

interface IOptions {
  attributes?: string[];
  formatProps?: (props: any) => any;
  wrapComponent?: <P>(child: ComponentFactory<P>) => ComponentFactory<P>;
}

/* -----------------------------------
 *
 * Errors
 *
 * -------------------------------- */

enum ErrorTypes {
  Promise = 'Error: Promises cannot be used for preactement SSR',
  Missing = 'Error: Cannot find component in provided function',
  Json = 'Error: Invalid JSON string passed to component',
}

/* -----------------------------------
 *
 * Element
 *
 * -------------------------------- */

interface CustomElement extends HTMLElement {
  __mounted: boolean;
  __component: ComponentFunction;
  __properties?: object;
  __instance?: ComponentType<any>;
  __children?: any[];
  __options: IOptions;
}

/* -----------------------------------
 *
 * Guards
 *
 * -------------------------------- */

const isPromise = (input: any): input is Promise<any> => {
  return input && typeof input.then === 'function';
};

/* -----------------------------------
 *
 * Define
 *
 * -------------------------------- */

function define<P = {}>(
  tagName: string,
  child: ComponentFunction<P>,
  options: IOptions = {}
): FunctionComponent<P> {
  const { wrapComponent } = options;
  const preRender = typeof window === 'undefined';
  const elementTag = getElementTag(tagName);

  if (!preRender) {
    customElements.define(elementTag, setupElement(child, options));

    return;
  }

  const content = child();

  if (isPromise(content)) {
    throw new Error(`${ErrorTypes.Promise} : <${tagName}>`);
  }

  let component = content;

  if (wrapComponent) {
    component = wrapComponent(content);
  }

  return (props: P) =>
    h(elementTag, { server: true }, [
      h('script', {
        type: 'application/json',
        dangerouslySetInnerHTML: { __html: JSON.stringify(props) },
      }),
      h(component, props),
    ]);
}

/* -----------------------------------
 *
 * Element
 *
 * -------------------------------- */

function getElementTag(tagName: string) {
  let result = tagName.toLowerCase();

  if (result.indexOf('-') < 0) {
    result = 'component-' + result;
  }

  return result;
}

/* -----------------------------------
 *
 * Setup
 *
 * -------------------------------- */

function setupElement<T>(component: ComponentFunction<T>, options: IOptions = {}): any {
  const { attributes = [] } = options;

  if (typeof Reflect !== 'undefined' && Reflect.construct) {
    const CustomElement = function () {
      const element = Reflect.construct(HTMLElement, [], CustomElement);

      element.__mounted = false;
      element.__component = component;
      element.__properties = {};
      element.__children = [];
      element.__options = options;

      return element;
    };

    CustomElement.observedAttributes = ['props', ...attributes];

    CustomElement.prototype = Object.create(HTMLElement.prototype);
    CustomElement.prototype.constructor = CustomElement;
    CustomElement.prototype.connectedCallback = onConnected;
    CustomElement.prototype.attributeChangedCallback = onAttributeChange;
    CustomElement.prototype.disconnectedCallback = onDisconnected;

    return CustomElement;
  }

  return class CustomElement extends HTMLElement {
    __mounted = false;
    __component = component;
    __properties = {};
    __children = [];
    __options = options;

    static observedAttributes = ['props', ...attributes];

    public connectedCallback() {
      onConnected.call(this);
    }

    public attributeChangedCallback(...args) {
      onAttributeChange.call(this, ...args);
    }

    public disconnectedCallback() {
      onDisconnected.call(this);
    }
  };
}

/* -----------------------------------
 *
 * Connected
 *
 * -------------------------------- */

async function onConnected(this: CustomElement) {
  const { tagName } = this;
  const { wrapComponent } = this.__options;

  const attributes = getElementAttributes.call(this);
  const props = this.getAttribute('props');
  const json = this.querySelector('[type="application/json"]');
  const data = parseJson.call(this, props || json?.innerHTML || '{}');

  json?.remove();

  let response = this.__component();
  let component: ComponentType;

  if (isPromise(response)) {
    component = await getAsyncComponent(response, this.tagName);
  } else {
    component = response;
  }

  if (!component) {
    console.error(ErrorTypes.Missing, `: <${tagName.toLowerCase()}>`);

    return;
  }

  if (wrapComponent) {
    component = wrapComponent(component);
  }

  let children;

  if (!this.hasAttribute('server')) {
    children = h(Markup, { markup: this.innerHTML, wrap: false });
  }

  this.__properties = { ...data, ...attributes };
  this.__instance = component;
  this.__children = children || [];
  this.__mounted = true;

  this.removeAttribute('server');
  this.innerHTML = '';

  render(h(component, { ...data, ...attributes, parent: this, children }), this);
}

/* -----------------------------------
 *
 * Attribute
 *
 * -------------------------------- */

function onAttributeChange(this: CustomElement, name: string, original: string, updated: string) {
  if (!this.__mounted) {
    return;
  }

  updated = updated == null ? undefined : updated;

  let props = this.__properties;

  if (name === 'props') {
    props = { ...props, ...parseJson.call(this, updated) };
  } else {
    props[getPropKey(name)] = updated;
  }

  this.__properties = props;

  render(h(this.__instance, { ...props, parent: this, children: this.__children }), this);
}

/* -----------------------------------
 *
 * Disconnected
 *
 * -------------------------------- */

function onDisconnected(this: CustomElement) {
  render(null, this);
}

/* -----------------------------------
 *
 * Attributes
 *
 * -------------------------------- */

function getElementAttributes(this: CustomElement) {
  const { attributes = [] } = this.__options;

  const result = {};

  if (!this.hasAttributes()) {
    return result;
  }

  for (var i = this.attributes.length - 1; i >= 0; i--) {
    const item = this.attributes[i];

    if (attributes.indexOf(item.name) === -1) {
      continue;
    }

    result[getPropKey(item.name)] = item.value;
  }

  return result;
}

/* -----------------------------------
 *
 * Component
 *
 * -------------------------------- */

async function getAsyncComponent(component: ComponentResult, tagName: string) {
  let result: ComponentFactory;

  const response = await component;

  if (typeof response === 'function') {
    return response;
  }

  if (typeof response === 'object') {
    result = response[getNameFromTag(tagName)] || void 0;
  }

  return result;
}

/* -----------------------------------
 *
 * Attribute
 *
 * -------------------------------- */

function getPropKey(value: string) {
  return value.replace(/-([a-z])/g, (value) => value[1].toUpperCase());
}

/* -----------------------------------
 *
 * Tag
 *
 * -------------------------------- */

function getNameFromTag(value: string) {
  value = value.toLowerCase();

  return value.replace(/(^\w|-\w)/g, (item) => item.replace(/-/, '').toUpperCase());
}

/* -----------------------------------
 *
 * parseJson
 *
 * -------------------------------- */

function parseJson(this: CustomElement, value: string): object {
  const { tagName } = this;
  const { formatProps } = this.__options;

  let result = {};

  try {
    result = JSON.parse(value);
  } catch {
    console.error(ErrorTypes.Json, `: <${tagName.toLowerCase()}>`);
  }

  if (formatProps) {
    result = formatProps(result);
  }

  return result;
}

/* -----------------------------------
 *
 * Export
 *
 * -------------------------------- */

export { define };
