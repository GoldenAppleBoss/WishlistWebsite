const $ = selector => document.querySelector(selector);
const content = $('#content');
const authForm = $('#auth-form');
const dialog = $('#duplicate');
const hostedSite = $('meta[name="wishlist-hosted"]')?.content;
const priorities = { top: 'Top priority', high: 'High priority', regular: 'Standard', low: 'Low priority' };
const priorityOrder = Object.keys(priorities);
const priceRanges = { '0-25': 'Under $25', '25-50': '$25–$49.99', '50-100': '$50–$99.99', '100-250': '$100–$249.99', '250+': '$250 and up' };
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const nameList = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' });
const sessionKey = 'wishlist-session';
const items = new Map();
const cards = new Map();
const pending = new Set();
let token = sessionStorage.getItem(sessionKey);
let signup = false;
let live;
let cartView;
let status;
let duplicateItem;
let refreshAvailability;

function element(tag, attributes = {}, ...children) {
  const node = Object.assign(document.createElement(tag), attributes);
  node.append(...children);
  return node;
}

function giftArt() {
  return $('#gift-art').content.cloneNode(true);
}

function countLabel(count) {
  return String(count) + (count === 1 ? ' item' : ' items');
}

function itemPriority(item) {
  return Object.hasOwn(priorities, item.priority) ? item.priority : 'regular';
}

function itemPrice(item) {
  if (!Number.isFinite(item.price)) return 'Price not listed';
  const startingPrice = money.format(item.price);
  if (!Number.isFinite(item.priceMax)) return startingPrice;
  const range = startingPrice + '–' + money.format(item.priceMax);
  return item.quantity ? range + ' for ' + item.quantity + ' units' : range;
}

function priceContext(item) {
  const context = [];
  if (item.priceSource && /^https:\/\//i.test(item.priceSource.url)) {
    const source = link(item.priceSource.label, item.priceSource.url);
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    context.push(source);
  }
  if (item.priceNote) context.push(element('p', {}, item.priceNote));
  return context.length ? [element('div', { className: 'price-context' }, ...context)] : [];
}

function comparePrices(a, b, direction) {
  if (!Number.isFinite(a.price)) return Number(Number.isFinite(b.price));
  if (!Number.isFinite(b.price)) return -1;
  return direction * (a.price - b.price);
}

function button(label, onclick, className = 'button') {
  return element('button', { type: 'button', className, onclick }, label);
}

function link(label, href, className = '') {
  return element('a', { href, className }, label);
}

function image(src) {
  return element('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
}

function pageHeading(title, parentTitle, parentPath) {
  document.title = title + ' · Jack’s Wishlists';
  return element('header', { className: 'page-heading' },
    link(parentTitle, parentPath, 'back-link'), element('h1', {}, title));
}

function addHeadingCover(heading, path) {
  const cover = image(path);
  cover.loading = 'eager';
  const copy = element('div', { className: 'wishlist-heading-copy' }, ...heading.childNodes);
  heading.classList.add('wishlist-heading');
  heading.append(copy, cover);
}

function renderHome(wishlists) {
  document.title = 'Jack’s Wishlists';
  content.append(element('section', { className: 'home-hero' },
    element('div', { className: 'hero-copy' }, element('h1', {}, 'Jack’s', element('br'), 'Wishlists')),
    giftArt()));
  const heading = element('h2', { id: 'wishlists-heading' }, 'Wishlists');
  const grid = element('div', { className: 'wishlist-grid' });
  for (const list of wishlists) {
    const art = list.image ? image(list.image) : giftArt();
    const count = list.categories.reduce((sum, category) => sum + category.items.length, 0);
    const tile = element('a', { className: 'wishlist-tile', href: '/' + list.id },
      element('div', { className: 'wishlist-art' }, art),
      element('div', { className: 'tile-meta' }, element('h3', {}, list.occasion ?? list.title),
        element('p', {}, countLabel(count))));
    grid.append(tile);
  }
  const section = element('section', { className: 'home-lists' }, heading, grid);
  section.setAttribute('aria-labelledby', heading.id);
  content.append(section);
}

function sizingGuide(sizes) {
  const measurements = element('dl', { className: 'size-measurements' });
  for (const [label, size] of Object.entries(sizes)) {
    measurements.append(element('div', {}, element('dt', {}, label), element('dd', {}, size)));
  }
  return element('details', { className: 'sizing-guide' }, element('summary', {}, 'Sizing guide'), measurements);
}

function renderList(list) {
  const grid = element('div', { className: 'category-grid' });
  for (const category of list.categories) {
    const tile = element('a', {
      className: category.image ? 'category-tile' : 'category-tile no-image', href: '/' + list.id + '/' + category.id
    },
      element('div', { className: 'tile-meta' }, element('h2', {}, category.title),
        element('p', {}, countLabel(category.items.length))));
    if (category.image) tile.prepend(element('div', { className: 'tile-image' }, image(category.image)));
    grid.append(tile);
  }
  const heading = pageHeading(list.title, 'All wishlists', '/');
  if (list.image) addHeadingCover(heading, list.image);
  content.append(heading);
  if (list.sizing) content.append(sizingGuide(list.sizing));
  content.append(grid);
}

function storeLink(item, ...children) {
  if (!item.url || !/^https?:\/\//i.test(item.url)) return element('div', { className: 'product-link' }, ...children);
  const store = element('a', { href: item.url, className: 'product-link', target: '_blank', rel: 'noopener noreferrer' }, ...children);
  store.setAttribute('aria-label', item.title + ' (opens in a new tab)');
  return store;
}

function productCard(item) {
  const details = element('div', { className: 'product-meta' },
    element('h2', {}, item.title), element('p', { className: 'price' }, itemPrice(item)));
  if (item.merchant) details.append(element('p', { className: 'product-merchant' }, item.merchant));
  const purchase = storeLink(item, details);
  if (item.image) purchase.prepend(element('div', { className: 'product-image' }, image(item.image)));
  const tier = itemPriority(item);
  const badge = element('span', { className: 'priority ' + tier }, priorities[tier]);
  const cartLabel = element('span', { className: 'reservation', hidden: true });
  const action = button('Add to cart', () => {
    if (status.mine.has(item.id)) {
      location.assign('/cart');
    } else if (status.reserved.has(item.id)) {
      confirmDuplicate(item);
    } else {
      changeCart(item, 'add');
    }
  });
  const article = element('article', { className: item.image ? 'product' : 'product no-image' }, badge, purchase);
  if (item.notes) article.append(element('p', { className: 'product-notes' }, item.notes));
  article.append(...priceContext(item));
  article.append(element('div', { className: 'product-actions' }, cartLabel, action));
  cards.set(item.id, { article, action, cartLabel });
  return article;
}

function filterField(label, name, values) {
  const select = element('select', { name });
  for (const [value, title] of Object.entries(values)) select.add(new Option(title, value));
  return element('label', { className: 'filter-field' }, label, select);
}

function renderCategory(list, category) {
  const listPath = '/' + list.id;
  const header = pageHeading(category.title, list.title, listPath);
  if (category.image) {
    addHeadingCover(header, category.image);
    header.classList.add('category-heading');
  }
  const nav = element('nav', { className: 'category-nav' });
  nav.setAttribute('aria-label', 'Wishlist categories');
  for (const sibling of list.categories) {
    const entry = link(sibling.title, listPath + '/' + sibling.id);
    if (sibling === category) entry.setAttribute('aria-current', 'page');
    nav.append(entry);
  }
  header.append(nav);

  const search = element('input', { type: 'search', name: 'search' });
  const searchField = element('label', { className: 'filter-field search-field' }, 'Search items', search);
  const sort = filterField('Sort by', 'sort', { priority: 'Priority', asc: 'Price low to high', desc: 'Price high to low', name: 'Name A–Z' });
  const filters = element('form', { className: 'filters' });
  filters.setAttribute('aria-label', 'Filter and sort items');
  const prices = { all: 'Any price', ...(category.priceRanges ?? priceRanges) };
  if (category.items.some(item => !Number.isFinite(item.price))) prices.unpriced = 'Price not listed';
  const options = element('div', { className: 'filter-options', id: 'filter-options' },
    filterField('Price', 'price', prices),
    filterField('Priority', 'priority', { all: 'All priorities', ...priorities }),
    filterField('Availability', 'availability', {
      all: 'All items', available: 'Available', mine: 'In your cart', reserved: 'In another cart'
    }));
  if (category.types && Object.keys(category.types).length) {
    options.append(filterField('Type', 'type', { all: 'All types', ...category.types }));
  }
  const toggle = button('Filters', () => setExpanded(options.hidden), 'text-button filter-toggle');
  toggle.setAttribute('aria-controls', options.id);
  function setExpanded(expanded) {
    options.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
  }
  setExpanded(!matchMedia('(max-width: 39rem)').matches);
  options.append(button('Clear filters', clearFilters, 'text-button'));
  filters.append(element('div', { className: 'filter-toolbar' }, toggle, searchField, sort), options);

  const results = element('p', { className: 'results', role: 'status' });
  const empty = element('div', { className: 'empty', hidden: true },
    element('p', {}, 'No items match these filters.'), button('Clear filters', clearFilters, 'text-button'));
  const products = element('div', { className: 'products' }, ...category.items.map(productCard));
  content.append(header);
  if (category.id === 'apparel' && list.sizing) content.append(sizingGuide(list.sizing));
  content.append(filters, results, products, empty);

  function clearFilters() {
    search.value = '';
    for (const name of ['price', 'priority', 'availability', 'type']) {
      const select = filters.elements.namedItem(name);
      if (select) select.value = 'all';
    }
    if (empty.contains(document.activeElement)) toggle.focus();
    updateProducts();
  }

  function updateProducts() {
    const current = new FormData(filters);
    const price = current.get('price');
    const priority = current.get('priority');
    const type = current.get('type') ?? 'all';
    const availability = current.get('availability');
    const query = search.value.toLowerCase().trim();
    const min = price === 'all' ? 0 : Number(price.split(/[-+]/)[0]);
    const max = price.includes('-') ? Number(price.split('-')[1]) : Infinity;
    const focused = document.activeElement;
    let focusWasHidden = false;
    let visible = 0;
    for (const item of category.items) {
      const card = cards.get(item.id).article;
      const mine = status?.mine.has(item.id);
      const reserved = status?.reserved.has(item.id);
      const matchesAvailability = availability === 'all'
        || (availability === 'available' && !mine && !reserved)
        || (availability === 'mine' && mine)
        || (availability === 'reserved' && reserved);
      const listedPrice = Number.isFinite(item.price);
      const matchesPrice = price === 'all' || (price === 'unpriced' && !listedPrice)
        || (listedPrice && (item.priceMax ?? item.price) >= min && item.price < max);
      card.hidden = !(matchesPrice
        && (priority === 'all' || itemPriority(item) === priority)
        && (type === 'all' || item.type === type)
        && matchesAvailability && item.title.toLowerCase().includes(query));
      if (card.hidden && card.contains(focused)) focusWasHidden = true;
      visible += Number(!card.hidden);
    }
    const active = [price, priority, type, availability].filter(value => value !== 'all').length + Number(Boolean(query));
    toggle.textContent = active ? 'Filters (' + active + ')' : 'Filters';
    const count = countLabel(visible);
    if (results.textContent !== count) results.textContent = count;
    empty.hidden = visible > 0;
    if (focusWasHidden) toggle.focus();
  }

  const sorters = {
    priority: (a, b) => priorityOrder.indexOf(itemPriority(a)) - priorityOrder.indexOf(itemPriority(b)) || comparePrices(a, b, -1),
    name: (a, b) => a.title.localeCompare(b.title),
    asc: (a, b) => comparePrices(a, b, 1),
    desc: (a, b) => comparePrices(a, b, -1)
  };
  function sortProducts() {
    const value = filters.elements.namedItem('sort').value;
    for (const item of [...category.items].sort(sorters[value])) products.append(cards.get(item.id).article);
  }

  filters.addEventListener('input', event => {
    if (event.target === search) updateProducts();
  });
  filters.addEventListener('change', event => {
    if (event.target.name === 'sort') sortProducts();
    else if (event.target !== search) updateProducts();
  });
  filters.addEventListener('submit', event => event.preventDefault());
  refreshAvailability = () => {
    if (filters.elements.namedItem('availability').value !== 'all') updateProducts();
  };
  sortProducts();
  updateProducts();
}

function renderCart() {
  content.append(pageHeading('Your cart', 'All wishlists', '/'),
    element('p', { className: 'cart-intro' }, 'Keep track of the gifts you plan to buy.'));
  cartView = element('div', { className: 'cart-view' });
  content.append(cartView);
}

function updateCartView() {
  const focused = document.activeElement;
  const focusItem = focused?.dataset.cartItem;
  const rows = [];
  for (const id of status.mine) {
    const { item, list, category } = items.get(id);
    const owners = element('p', { className: 'reservation cart-owners', hidden: true });
    owners.dataset.ownersFor = id;
    const details = element('div', { className: 'cart-details' },
      element('h2', {}, storeLink(item, item.title)),
      link(list.title + ' · ' + category.title, '/' + list.id + '/' + category.id, 'cart-source'),
      element('p', { className: 'price' }, itemPrice(item)), ...priceContext(item), owners);
    const remove = button('Remove', () => changeCart(item, 'remove'), 'button secondary');
    remove.dataset.cartItem = id;
    remove.setAttribute('aria-label', 'Remove ' + item.title);
    const row = element('li', { className: item.image ? 'cart-row' : 'cart-row no-image' }, details, remove);
    if (item.image) row.prepend(image(item.image));
    rows.push(row);
  }
  if (rows.length) {
    cartView.replaceChildren(element('ul', { className: 'cart-items' }, ...rows));
  } else {
    cartView.replaceChildren(element('div', { className: 'empty' },
      element('p', {}, 'Your cart is empty.'), link('Browse wishlists', '/', 'button')));
  }
  if (focusItem) {
    const nextFocus = [...cartView.querySelectorAll('button')].find(node => node.dataset.cartItem === focusItem)
      ?? cartView.querySelector('button, a');
    nextFocus?.focus();
  }
}

function renderPage(wishlists) {
  const path = location.pathname.replace(/\/$/, '').replace(/\.html$/, '');
  if (path === '/cart') return renderCart();
  const [, listId, categoryId] = path.split('/');
  const list = wishlists.find(entry => entry.id === listId);
  if (list) {
    const category = list.categories.find(entry => entry.id === categoryId);
    return category ? renderCategory(list, category) : renderList(list);
  }
  // The original category URLs are still valid.
  const christmas = wishlists.find(entry => entry.id === 'christmas');
  const legacy = christmas?.categories.find(entry => entry.id === listId);
  if (legacy) return renderCategory(christmas, legacy);
  renderHome(wishlists);
}

class ApiError extends Error {
  constructor(status, problem) {
    super(problem.error ?? 'Could not connect. Try again.');
    this.status = status;
    this.cart = problem.cart;
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal = AbortSignal.timeout(10000) } = {}) {
  headers = { Accept: 'application/json', ...headers };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch('/api/' + path, {
    method, headers, body, signal, cache: 'no-store'
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem);
  }
  return response;
}

function applyCart(cart) {
  if (status && status.instance === cart.instance && status.revision > cart.revision) return;
  const myItemsChanged = !status || cart.mine.length !== status.mine.size
    || cart.mine.some(id => !status.mine.has(id));
  status = {
    ...cart,
    mine: new Set(cart.mine),
    reserved: new Set(cart.reserved),
    owners: new Map(Object.entries(cart.owners ?? {}))
  };
  $('#cart-count').textContent = String(status.mine.size);
  for (const [id, { article, action, cartLabel }] of cards) {
    const mine = status.mine.has(id);
    const reserved = status.reserved.has(id);
    const owners = status.owners.get(id) ?? [];
    article.classList.toggle('is-reserved', reserved);
    cartLabel.hidden = !owners.length;
    cartLabel.textContent = owners.length ? 'In cart · ' + nameList.format(owners) : '';
    const title = items.get(id).item.title;
    action.textContent = mine ? 'In your cart' : 'Add to cart';
    action.setAttribute('aria-label', mine ? title + ' is in your cart. View cart' : 'Add ' + title + ' to cart');
  }
  refreshAvailability?.();
  if (cartView) {
    if (myItemsChanged) updateCartView();
    for (const label of cartView.querySelectorAll('[data-owners-for]')) {
      const owners = otherOwners(label.dataset.ownersFor);
      label.hidden = !owners.length;
      label.textContent = owners.length ? 'Also in cart · ' + nameList.format(owners) : '';
    }
  }
  if (dialog.open && duplicateItem) updateDuplicateText(duplicateItem);
}

function otherOwners(id) {
  const ownName = $('#display-name').textContent;
  return (status.owners.get(id) ?? []).filter(name => name !== ownName);
}

function updateDuplicateText(item) {
  const owners = otherOwners(item.id);
  const hasReservation = status.reserved.has(item.id);
  $('#duplicate-title').textContent = hasReservation ? 'Already in another cart' : 'Available again';
  let message = item.title + ' is available again. Add it to your cart?';
  if (owners.length) {
    const verb = owners.length === 1 ? ' has ' : ' have ';
    message = nameList.format(owners) + verb + item.title + ' in their cart' + (owners.length === 1 ? '' : 's')
      + '. Add it to yours anyway?';
  } else if (hasReservation) {
    message = item.title + ' is in someone else’s cart. Add it to yours anyway?';
  }
  $('#duplicate-text').textContent = message;
}

function confirmDuplicate(item) {
  duplicateItem = item;
  dialog.returnValue = 'cancel';
  updateDuplicateText(item);
  dialog.showModal();
}

dialog.querySelector('form').addEventListener('submit', event => {
  const item = duplicateItem;
  duplicateItem = undefined;
  if (event.submitter?.value === 'continue' && item && token) changeCart(item, 'add', true);
});

dialog.addEventListener('cancel', () => {
  duplicateItem = undefined;
});

async function changeCart(item, action, continueAnyway = false) {
  if (pending.has(item.id)) return;
  const activeToken = token;
  const control = cards.get(item.id)?.action
    ?? [...content.querySelectorAll('[data-cart-item]')].find(node => node.dataset.cartItem === item.id);
  // aria-disabled preserves focus for a repeated action or when a cart row disappears.
  pending.add(item.id);
  control?.setAttribute('aria-disabled', 'true');
  $('#notice').textContent = '';
  let conflict = false;
  try {
    const response = await request('cart', { method: 'POST', body: { itemId: item.id, action, continueAnyway } });
    const cart = await response.json();
    if (token !== activeToken) return;
    applyCart(cart);
    $('#notice').textContent = item.title + (action === 'add' ? ' added to your cart.' : ' removed from your cart.');
  } catch (error) {
    if (token !== activeToken) return;
    if (error.status === 409) {
      if (error.cart) applyCart(error.cart);
      conflict = true;
    }
    else if (error.status === 401) showSignIn('Your session has ended. Sign in again.');
    else $('#notice').textContent = error instanceof ApiError ? error.message : 'Could not update your cart. Try again.';
  } finally {
    pending.delete(item.id);
    control?.removeAttribute('aria-disabled');
  }
  if (conflict && token === activeToken) confirmDuplicate(item);
}

async function connectCart(signal) {
  if (hostedSite) return pollHostedCart(signal);
  while (!signal.aborted) {
    try {
      const response = await request('cart/live', { signal });
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (line && !signal.aborted) applyCart(JSON.parse(line));
          }
          $('#connection').hidden = true;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 401) {
        showSignIn('Your session has ended. Sign in again.');
        return;
      }
    }
    if (signal.aborted) return;
    $('#connection').hidden = false;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

async function pollHostedCart(signal) {
  while (!signal.aborted) {
    let delay = 2000;
    if (!document.hidden) {
      try {
        const cursor = new URLSearchParams({ since: status.revision, instance: status.instance });
        const response = await request('cart/live?' + cursor, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])
        });
        if (response.status !== 204) {
          const cart = await response.json();
          if (!signal.aborted) applyCart(cart);
        }
        $('#connection').hidden = true;
      } catch (error) {
        if (signal.aborted) return;
        if (error.status === 401) {
          showSignIn('Your session has ended. Sign in again.');
          return;
        }
        $('#connection').hidden = false;
        delay = 10000;
      }
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

function errorMessage(message) {
  $('#auth-error').textContent = message;
  $('#auth-error').hidden = !message;
}

function setAuthMode(create) {
  signup = create;
  const title = signup ? 'Create an account' : 'Sign in';
  $('#auth-title').textContent = title;
  $('#auth-submit').textContent = title;
  $('#auth-prompt').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#switch-mode').textContent = signup ? 'Sign in' : 'Create an account';
  $('#password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#password').value = '';
  errorMessage('');
}

function showSignIn(message = '') {
  live?.abort();
  token = null;
  sessionStorage.removeItem(sessionKey);
  duplicateItem = undefined;
  if (dialog.open) dialog.close('cancel');
  cartView = undefined;
  refreshAvailability = undefined;
  status = undefined;
  items.clear();
  cards.clear();
  content.replaceChildren();
  content.hidden = true;
  $('#account').hidden = true;
  $('#startup').hidden = true;
  $('#retry').hidden = true;
  $('#connection').hidden = true;
  $('#notice').textContent = '';
  $('#auth').hidden = false;
  document.title = 'Sign in · Jack’s Wishlists';
  authForm.reset();
  setAuthMode(false);
  errorMessage(message);
  $('#name').focus();
}

async function loadCatalogue() {
  $('#startup').hidden = false;
  $('#startup').textContent = 'Loading wishlists…';
  $('#retry').hidden = true;
  $('#auth').hidden = true;
  try {
    const response = await request('catalogue');
    const data = await response.json();
    for (const list of data.wishlists) {
      for (const category of list.categories) {
        for (const item of category.items) items.set(item.id, { item, list, category });
      }
    }
    $('#display-name').textContent = data.name;
    $('#startup').hidden = true;
    $('#account').hidden = false;
    if (location.pathname === '/cart') $('#cart-link').setAttribute('aria-current', 'page');
    renderPage(data.wishlists);
    applyCart(data.cart);
    content.hidden = false;
    $('#main').focus();
    live = new AbortController();
    connectCart(live.signal);
  } catch (error) {
    if (error.status === 401) return showSignIn('Your session has ended. Sign in again.');
    $('#startup').textContent = 'The wishlists could not load.';
    $('#retry').hidden = false;
  }
}

$('#auth-art').append(giftArt());
$('#switch-mode').addEventListener('click', () => {
  setAuthMode(!signup);
  $('#name').focus();
});
$('#retry').addEventListener('click', loadCatalogue);
authForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(authForm));
  $('#auth-submit').disabled = true;
  $('#switch-mode').disabled = true;
  errorMessage('');
  try {
    const response = await request(signup ? 'signup' : 'login', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Wishlist-Name': encodeURIComponent(data.name) },
      body: data.password
    });
    token = (await response.json()).token;
    sessionStorage.setItem(sessionKey, token);
    $('#password').value = '';
    await loadCatalogue();
  } catch (error) {
    errorMessage(error instanceof ApiError ? error.message : 'Could not connect. Try again.');
  } finally {
    $('#auth-submit').disabled = false;
    $('#switch-mode').disabled = false;
  }
});

$('#sign-out').addEventListener('click', async () => {
  $('#sign-out').disabled = true;
  try {
    await request('logout', { method: 'POST', signal: AbortSignal.timeout(4000) });
    showSignIn();
  } catch (error) {
    if (error.status === 401) showSignIn();
    else $('#notice').textContent = 'Could not sign out. Try again.';
  } finally {
    $('#sign-out').disabled = false;
  }
});

window.addEventListener('pagehide', () => live?.abort());
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

if (token) loadCatalogue();
else showSignIn();
