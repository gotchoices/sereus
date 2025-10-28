const hamburger = document.getElementById('hamburger-button');
const navMenu = document.getElementById('nav-menu');

function setupPageLinks() {
  document.querySelectorAll('a[data-page]').forEach(link => {
    link.addEventListener('click', function(event) {
      event.preventDefault();
      const page = event.currentTarget.getAttribute('data-page');
      window.location.hash = page;
      if (navMenu) {
        navMenu.classList.remove('open');
        window.scrollTo(0, 0);
      }
    });
  });
}

function loadContent(page) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${page}.html`, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      if (xhr.status === 200) {
        document.getElementById('content').innerHTML = xhr.responseText;
        document.title = `Sereus - ${page.charAt(0).toUpperCase() + page.slice(1)}`;
        setupPageLinks();
        // Attach CTA handlers if present
        const joinButton = document.querySelector('.cta-button.join');
        if (joinButton) {
          joinButton.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.hash = 'join';
          });
        }
        const learnButton = document.querySelector('.cta-button.learn');
        if (learnButton) {
          learnButton.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.hash = 'overview';
          });
        }
      } else if (xhr.status === 404) {
        document.getElementById('content').innerHTML = '<h1>Page Not Found</h1><p>The page you are looking for does not exist.</p>';
        document.title = 'Sereus - 404';
      }
    }
  };
  xhr.send();
}

function handleHashChange() {
  const page = window.location.hash.slice(1) || 'home';
  loadContent(page);
}

document.addEventListener('DOMContentLoaded', function() {
  window.addEventListener('hashchange', handleHashChange);
  handleHashChange();
  setupPageLinks();

  if (hamburger) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      navMenu.classList.toggle('open');
    });
  }
});


