// Shared nav + mobile sliding drawer
(function(){
  // Find the nav container — pages use different patterns
  var nav = document.querySelector('.topbar .nav')
         || document.querySelector('.nav-links')
         || document.querySelector('.header-nav');
  if (!nav) return;

  // Find the parent bar
  var bar = document.querySelector('.topbar') || document.querySelector('.header') || nav.parentElement;

  // Mark active link
  var path = location.pathname;
  nav.querySelectorAll('a').forEach(function(a){
    var href = a.getAttribute('href');
    if (!href) return;
    if (href === path || (path === '/' && href === '/') ||
        (href !== '/' && href !== '/logout' && path.startsWith(href))) {
      a.classList.add('active');
    }
  });

  // Inject hamburger + overlay
  if (bar && !bar.querySelector('.mobile-menu-btn')) {
    var btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', 'Open navigation');
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    btn.onclick = toggleNav;
    bar.appendChild(btn);

    var overlay = document.createElement('div');
    overlay.className = 'mobile-overlay';
    overlay.onclick = toggleNav;
    document.body.appendChild(overlay);

    // Add close button inside nav
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'position:absolute;top:16px;right:16px;background:none;border:none;color:var(--text-2,#9ba3b8);font-size:20px;cursor:pointer;padding:4px';
    closeBtn.innerHTML = '✕';
    closeBtn.onclick = toggleNav;
    nav.insertBefore(closeBtn, nav.firstChild);
  }

  function toggleNav() {
    nav.classList.toggle('open');
    var o = document.querySelector('.mobile-overlay');
    if (o) o.classList.toggle('open');
    document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
  }

  // Close on Escape
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && nav.classList.contains('open')) toggleNav();
  });

  // Close on link click (mobile)
  nav.addEventListener('click', function(e){
    if (e.target.closest('a') && window.innerWidth <= 768) {
      setTimeout(toggleNav, 50);
    }
  });
})();
