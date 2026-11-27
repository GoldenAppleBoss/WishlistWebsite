import { readFileSync } from 'node:fs';

export const wishlists = JSON.parse(readFileSync(new URL('../wishlists.json', import.meta.url), 'utf8'));
export const itemIds = new Set();
export const imagePaths = new Set(['/images/christmas-portrait.jpg']);
export const pagePaths = new Set(['/', '/cart']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function addImage(path) {
  if (!/^\/images\/[a-z0-9-]+\.(?:webp|jpg)$/.test(path)) throw new Error('Invalid catalogue image: ' + path);
  imagePaths.add(path);
}

function addPage(path) {
  if (pagePaths.has(path)) throw new Error('Duplicate catalogue URL: ' + path);
  pagePaths.add(path);
}

for (const list of wishlists) {
  if (!slugPattern.test(list.id) || list.id === 'api' || list.id === 'index') {
    throw new Error('Invalid wishlist ID: ' + list.id);
  }
  addPage('/' + list.id);
  if (list.image) addImage(list.image);
  for (const category of list.categories) {
    if (!slugPattern.test(category.id)) throw new Error('Invalid category ID: ' + category.id);
    addPage('/' + list.id + '/' + category.id);
    if (list.id === 'christmas') addPage('/' + category.id);
    if (category.image) addImage(category.image);
    for (const item of category.items) {
      if (itemIds.has(item.id)) throw new Error('Duplicate catalogue item ID: ' + item.id);
      itemIds.add(item.id);
      if (item.image) addImage(item.image);
    }
  }
}
