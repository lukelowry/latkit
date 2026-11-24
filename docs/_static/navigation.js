/* global document, DOCUMENTATION_OPTIONS */
// Local HTML can read the search index, but Chrome blocks fetching pages for excerpts.
if (document.location.protocol === 'file:') DOCUMENTATION_OPTIONS.SHOW_SEARCH_SUMMARY = false;

// Keep Furo's CSS drawer and expose the menu to keyboard users.
const menu = document.getElementById('docs-menu');
const drawer = document.getElementById('__navigation');
const main = document.querySelector('.main');
const mobile = globalThis.matchMedia('(max-width: 63em)');
const navigation = document.getElementById('site-navigation');

if (menu && drawer && navigation) {
  const current = navigation.querySelector('li.current-page > a');
  if (current)
    current.setAttribute(
      'aria-current',
      current.getAttribute('href') === '#' ? 'page' : 'location',
    );

  menu.tabIndex = 0;
  menu.setAttribute('role', 'button');
  menu.setAttribute('aria-controls', navigation.id);
  menu.setAttribute('aria-expanded', String(drawer.checked));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menu.click();
    }
  });
  drawer.addEventListener('change', () => {
    menu.setAttribute('aria-expanded', String(drawer.checked));
    if (main) main.inert = mobile.matches && drawer.checked;
    if (drawer.checked) (current ?? navigation.querySelector('a'))?.focus();
    else if (mobile.matches) menu.focus();
  });
  mobile.addEventListener('change', () => {
    if (!mobile.matches && drawer.checked) drawer.click();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.checked) drawer.click();
  });
}
