const filters = document.querySelector('#filters');

if (filters) {
  const products = document.querySelector('#products');
  const cards = Array.from(products.children);
  const results = document.querySelector('#results');
  const empty = document.querySelector('#empty');
  const options = document.querySelector('#filter-options');
  const toggle = document.querySelector('.filter-toggle');

  function updateProducts() {
    const current = new FormData(filters);
    const priceRange = current.get('price');
    const priority = current.get('priority');
    const type = current.get('type') ?? 'all';
    const direction = current.get('sort') === 'asc' ? 1 : -1;
    const [min, max] = priceRange === 'all' ? [0, Infinity]
      : priceRange.endsWith('+') ? [Number(priceRange.slice(0, -1)), Infinity]
      : priceRange.split('-').map(Number);
    const sorted = [...cards].sort((a, b) => direction * (a.dataset.price - b.dataset.price));
    let visible = 0;

    for (const card of sorted) {
      const price = Number(card.dataset.price);
      card.hidden = !(price >= min && price < max
        && (priority === 'all' || card.dataset.wanted === priority)
        && (type === 'all' || card.dataset.type === type));
      visible += Number(!card.hidden);
      products.append(card);
    }

    const active = [priceRange, priority, type].filter(value => value !== 'all').length;
    toggle.querySelector('span').textContent = active ? `Filters (${active})` : 'Filters';
    results.textContent = visible === 1 ? '1 item' : `${visible} items`;
    empty.hidden = visible !== 0;
  }

  filters.addEventListener('change', updateProducts);
  filters.addEventListener('submit', event => event.preventDefault());
  filters.addEventListener('reset', event => {
    event.preventDefault();
    for (const name of ['price', 'priority', 'type']) {
      const select = filters.elements.namedItem(name);
      if (select) select.value = 'all';
    }
    if (empty.contains(document.activeElement)) toggle.focus();
    updateProducts();
  });
  function setFiltersExpanded(expanded) {
    options.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
  }

  setFiltersExpanded(!window.matchMedia('(max-width: 39rem)').matches);
  toggle.addEventListener('click', () => setFiltersExpanded(options.hidden));
  window.addEventListener('pageshow', updateProducts);
}

const music = document.querySelector('#holiday-music');

if (music) {
  const musicToggle = document.querySelector('#music-toggle');
  const sceneToggle = document.querySelector('#scene-toggle');
  const main = document.querySelector('#main');
  const fireplace = document.querySelector('#fireplace');
  const audioStatus = document.querySelector('#audio-status');
  let playingRequest = false;

  function updateMusicButton() {
    musicToggle.setAttribute('aria-pressed', String(!music.paused));
    musicToggle.querySelector('span').textContent = music.paused ? 'Play music' : 'Pause music';
  }

  async function toggleMusic() {
    if (!music.paused) {
      music.pause();
      return;
    }
    if (playingRequest) return;
    audioStatus.hidden = true;
    playingRequest = true;
    try {
      await music.play();
    } catch (error) {
      if (error.name === 'AbortError') return;
      audioStatus.textContent = 'Music could not play. Try again.';
      audioStatus.hidden = false;
    } finally {
      playingRequest = false;
    }
  }

  function setScene(open) {
    fireplace.hidden = !open;
    main.hidden = open;
    document.body.classList.toggle('scene-open', open);
    document.querySelector('.skip').hidden = open;
    sceneToggle.setAttribute('aria-pressed', String(open));
    sceneToggle.querySelector('span').textContent = open ? 'Back to wishlist' : 'Fireplace';
    if (open && !fireplace.querySelector('span')) {
      const snow = fireplace.querySelector('.snow');
      for (let index = 0; index < 25; index += 1) {
        const flake = document.createElement('span');
        flake.style.setProperty('--position', `${((index * 29) % 100)}%`);
        flake.style.setProperty('--size', `${2 + index % 4}px`);
        flake.style.setProperty('--opacity', `${0.3 + (index % 5) / 10}`);
        flake.style.setProperty('--duration', `${12 + index % 11}s`);
        flake.style.setProperty('--delay', `-${index * 1.7}s`);
        snow.append(flake);
      }
    }
  }

  musicToggle.addEventListener('click', toggleMusic);
  music.addEventListener('play', updateMusicButton);
  music.addEventListener('pause', updateMusicButton);
  sceneToggle.addEventListener('click', () => setScene(fireplace.hidden));

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !fireplace.hidden) {
      setScene(false);
      sceneToggle.focus();
    }
    if (event.code === 'Space' && !event.repeat && (event.target === document.body || event.target === main)) {
      event.preventDefault();
      toggleMusic();
    }
  });
}
