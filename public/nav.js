// Shared nav — fixes mobile sliding drawer across all pages
// Overrides any existing toggleMobileNav to ensure consistent behavior
(function(){
  var nav = document.querySelector('.nav-links')
         || document.querySelector('.topbar .nav')
         || document.querySelector('.header-nav');
  if (!nav) return;

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

  // Find overlay — pages already have one, or we create it
  var overlay = document.querySelector('.mobile-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'mobile-overlay';
    document.body.appendChild(overlay);
  }
  // Ensure overlay click closes nav
  overlay.onclick = function(){ closeNav(); };

  // Find or create hamburger
  var bar = document.querySelector('.topbar') || document.querySelector('.header') || nav.parentElement;
  if (bar && !bar.querySelector('.mobile-menu-btn')) {
    var btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', 'Open navigation');
    btn.innerHTML = '☰';
    btn.onclick = function(){ openNav(); };
    bar.appendChild(btn);
  } else {
    // Rebind existing hamburger
    var existing = bar && bar.querySelector('.mobile-menu-btn');
    if (existing) {
      existing.onclick = function(){ toggleNav(); };
    }
  }

  // Add close button inside nav drawer if not present
  if (!nav.querySelector('.nav-close-btn')) {
    var closeBtn = document.createElement('button');
    closeBtn.className = 'nav-close-btn';
    closeBtn.style.cssText = 'position:absolute;top:14px;right:14px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);color:#eef0f6;font-size:15px;cursor:pointer;padding:6px 10px;border-radius:6px;z-index:100001;line-height:1';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.onclick = function(){ closeNav(); };
    nav.style.position = nav.style.position || 'relative';
    nav.insertBefore(closeBtn, nav.firstChild);
  }

  function openNav() {
    nav.classList.add('open');
    overlay.classList.add('open');
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
  }
  function closeNav() {
    nav.classList.remove('open');
    overlay.classList.remove('open');
    overlay.style.display = '';
    document.body.style.overflow = '';
  }
  function toggleNav() {
    if (nav.classList.contains('open')) closeNav(); else openNav();
  }

  // Override any page-level toggleMobileNav
  window.toggleMobileNav = toggleNav;

  // Close on Escape
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && nav.classList.contains('open')) closeNav();
  });

  // Close on nav link click (mobile)
  nav.addEventListener('click', function(e){
    if (e.target.closest('a') && window.innerWidth <= 768) {
      setTimeout(closeNav, 80);
    }
  });
})();
