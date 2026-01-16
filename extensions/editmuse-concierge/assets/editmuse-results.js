(function() {
  'use strict';

  // Debug helper
  const debug = function() {
    if (window.EDITMUSE_DEBUG && console && console.log) {
      console.log.apply(console, ['[EditMuse Results]'].concat(Array.prototype.slice.call(arguments)));
    }
  };

  // Event tracking helpers
  function getEventUrl() {
    // preserve Shopify app proxy params (shop/signature/timestamp/preview_theme_id)
    return '/apps/editmuse/event' + window.location.search;
  }

  function sendEvent(eventType, sid, metadata) {
    try {
      var url = getEventUrl();
      var payload = {
        eventType: eventType,
        sid: sid || null,
        metadata: metadata || {}
      };

      // Prefer beacon so navigation doesn't block
      if (navigator.sendBeacon) {
        var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
        return;
      }

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(payload)
      }).catch(function(){});
    } catch (e) {
      // silent
    }
  }

  // Safe insertBefore helper
  function safeInsertBefore(parent, node, before) {
    if (!parent || !node) {
      debug('safeInsertBefore: missing parent or node', { parent: !!parent, node: !!node });
      return;
    }
    if (before && before.parentNode === parent) {
      parent.insertBefore(node, before);
      debug('safeInsertBefore: inserted before reference node');
    } else {
      parent.appendChild(node);
      debug('safeInsertBefore: appended (no valid before node)');
    }
  }

  // Proxy URL helper
  const PROXY_BASE = '/apps/editmuse';
  function proxyUrl(path) {
    var normalizedPath = path.startsWith('/') ? path : '/' + path;
    return PROXY_BASE + normalizedPath;
  }

  // Fetch and cache shop settings from app proxy (once per page load)
  var shopConfigCache = null;
  var shopConfigPromise = null;
  function fetchShopConfig() {
    // Return cached config if available
    if (shopConfigCache !== null) {
      return Promise.resolve(shopConfigCache);
    }

    // Return existing promise if fetch is in progress
    if (shopConfigPromise) {
      return shopConfigPromise;
    }

    // Check sessionStorage first
    try {
      var cached = sessionStorage.getItem('editmuse_shop_config');
      if (cached) {
        shopConfigCache = JSON.parse(cached);
        return Promise.resolve(shopConfigCache);
      }
    } catch (e) {
      // Ignore parse errors
    }

    // Fetch from API
    shopConfigPromise = fetch(proxyUrl('/config') + window.location.search, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        // Include stored ETag for conditional request
        'If-None-Match': (function() {
          try {
            var cached = sessionStorage.getItem('editmuse_shop_config_etag');
            return cached || '';
          } catch (e) {
            return '';
          }
        })(),
      },
    })
      .then(function(response) {
        // 304 Not Modified - use cached config (skip storing new config)
        if (response.status === 304) {
          shopConfigPromise = null;
          try {
            var cached = sessionStorage.getItem('editmuse_shop_config');
            if (cached) {
              shopConfigCache = JSON.parse(cached);
              return shopConfigCache;
            }
          } catch (e) {
            // Fall through to default
          }
        }
        
        if (!response.ok) {
          shopConfigPromise = null;
          throw new Error('Failed to fetch config');
        }
        return response.json().then(function(config) {
          shopConfigCache = config;
          shopConfigPromise = null;
          // Cache config and ETag in sessionStorage
          try {
            sessionStorage.setItem('editmuse_shop_config', JSON.stringify(config));
            var etag = response.headers.get('ETag');
            if (etag) {
              sessionStorage.setItem('editmuse_shop_config_etag', etag);
            }
          } catch (e) {
            // Ignore storage errors
          }
          return config;
        });
      })
      .catch(function(error) {
        shopConfigPromise = null;
        // Return default config on error
        return {
          buttonLabel: 'Ask EditMuse',
          placementMode: 'inline',
          defaultResultsCount: 8,
          mode: 'guided',
          enabled: true,
        };
      });

    return shopConfigPromise;
  }

  function getSessionId() {
    // Check URL first, then fallback to sessionStorage
    var params = new URLSearchParams(window.location.search);
    var sid = params.get('sessionId') || params.get('sid') || params.get('editmuse_session');
    if (!sid) {
      sid = sessionStorage.getItem('editmuse_sid');
    }
    return sid;
  }

  // Loading messages that rotate while fetching results
  var loadingMessages = [
    'Analyzing your preferences...',
    'Searching through our catalog...',
    'Matching products to your style...',
    'Fine-tuning recommendations...'
  ];

  var loadingMessageInterval = null;

  function startLoadingAnimation() {
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) {
      // Retry after a short delay if container not ready
      setTimeout(startLoadingAnimation, 100);
      return;
    }
    
    var loadingText = container.querySelector('[data-editmuse-loading-text]');
    if (!loadingText) {
      // Retry after a short delay if text element not ready
      setTimeout(startLoadingAnimation, 100);
      return;
    }

    // Stop any existing interval
    if (loadingMessageInterval) {
      clearInterval(loadingMessageInterval);
    }

    var currentIndex = 0;

    // Update message immediately
    loadingText.textContent = loadingMessages[0];
    loadingText.className = 'editmuse-loading-text fade-in';

    // Cycle through messages every 4 seconds with fade animation
    loadingMessageInterval = setInterval(function() {
      // Fade out
      loadingText.className = 'editmuse-loading-text fade-out';
      
      // After fade out completes, change text and fade in
      setTimeout(function() {
        if (!loadingText) return; // Safety check
        currentIndex = (currentIndex + 1) % loadingMessages.length;
        loadingText.textContent = loadingMessages[currentIndex];
        loadingText.className = 'editmuse-loading-text fade-in';
      }, 400); // Half of transition duration (0.6s / 1.5 = ~400ms)
    }, 4000);
  }

  // Start animation immediately on page load (in case loading is already visible)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      // Small delay to ensure DOM is fully ready
      setTimeout(startLoadingAnimation, 50);
    });
  } else {
    // DOM already loaded, start immediately
    setTimeout(startLoadingAnimation, 50);
  }

  function stopLoadingAnimation() {
    if (loadingMessageInterval) {
      clearInterval(loadingMessageInterval);
      loadingMessageInterval = null;
    }
  }

  function showLoading() {
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) return;
    var loading = container.querySelector('[data-editmuse-loading]');
    var content = container.querySelector('[data-editmuse-content]');
    var error = container.querySelector('[data-editmuse-error]');
    var empty = container.querySelector('[data-editmuse-empty]');
    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
    if (empty) empty.style.display = 'none';
    
    // Start animated loading messages
    startLoadingAnimation();
  }

  function showError(msg) {
    stopLoadingAnimation(); // Stop animation on error
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) return;
    var loading = container.querySelector('[data-editmuse-loading]');
    var content = container.querySelector('[data-editmuse-content]');
    var error = container.querySelector('[data-editmuse-error]');
    var empty = container.querySelector('[data-editmuse-empty]');
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) {
      error.style.display = 'flex';
      var p = error.querySelector('p');
      if (p && msg) p.textContent = msg;
    }
    if (empty) empty.style.display = 'none';
  }

  function showContent() {
    stopLoadingAnimation(); // Stop animation when content loads
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) return;
    var loading = container.querySelector('[data-editmuse-loading]');
    var content = container.querySelector('[data-editmuse-content]');
    var error = container.querySelector('[data-editmuse-error]');
    var empty = container.querySelector('[data-editmuse-empty]');
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
    if (error) error.style.display = 'none';
    if (empty) empty.style.display = 'none';
  }

  function showEmpty(msg) {
    stopLoadingAnimation(); // Stop animation on empty
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) return;
    var loading = container.querySelector('[data-editmuse-loading]');
    var content = container.querySelector('[data-editmuse-content]');
    var error = container.querySelector('[data-editmuse-error]');
    var empty = container.querySelector('[data-editmuse-empty]');
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
    if (empty) {
      empty.style.display = 'flex';
      var p = empty.querySelector('p');
      if (p && msg) p.textContent = msg;
    }
  }

  function renderProducts(products) {
    debug('renderProducts called with', products.length, 'products');
    console.log('[EditMuse Results] products returned:', products.length);
    
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) {
      debug('Container not found!');
      return;
    }
    
    var grid = container.querySelector('[data-editmuse-grid]');
    if (!grid) {
      debug('Grid element not found! Looking for [data-editmuse-grid]');
      return;
    }
    
    var meta = container.querySelector('[data-editmuse-meta]');
    
    grid.innerHTML = '';

    if (!products || products.length === 0) {
      debug('No products to render');
      if (meta) meta.textContent = '';
      showEmpty('No recommendations available yet.');
      return;
    }
    
    // Update meta line with product count
    if (meta) {
      meta.textContent = products.length + ' product' + (products.length !== 1 ? 's' : '') + ' recommended';
    }
    
    debug('Rendering ALL products into grid (no limits)');

    // Render ALL products - NO LIMITS, NO SLICE, NO BREAK
    products.forEach(function(product, index) {
      // Card is an <a> tag so entire card is clickable
      var card = document.createElement('a');
      card.href = product.url || '/products/' + (product.handle || '');
      card.className = 'editmuse-results-card';
      card.style.textDecoration = 'none';
      card.style.color = 'inherit';

      // Image wrapper
      var imageWrapper = document.createElement('div');
      imageWrapper.className = 'editmuse-results-card-image-wrapper';
      
      if (product.image) {
        var img = document.createElement('img');
        // Set src and ensure no invalid srcset attributes
        img.src = product.image;
        // Remove any existing srcset to avoid invalid 'w' descriptor errors
        if (img.hasAttribute('srcset')) {
          img.removeAttribute('srcset');
        }
        img.alt = product.title || '';
        img.className = 'editmuse-results-card-image';
        imageWrapper.appendChild(img);
      } else {
        // Placeholder for missing image
        var placeholder = document.createElement('div');
        placeholder.className = 'editmuse-results-card-image-placeholder';
        placeholder.textContent = 'No image';
        imageWrapper.appendChild(placeholder);
      }
      
      card.appendChild(imageWrapper);

      // Card info wrapper
      var cardInfo = document.createElement('div');
      cardInfo.className = 'editmuse-results-card-info';

      if (product.title) {
        var title = document.createElement('h3');
        title.className = 'editmuse-results-card-title';
        title.textContent = product.title;
        cardInfo.appendChild(title);
      }

      if (product.price || product.priceAmount) {
        var price = document.createElement('p');
        price.className = 'editmuse-results-card-price';
        
        // Use priceAmount if available, otherwise fallback to price
        var priceValue = product.priceAmount || product.price;
        var currencyCode = product.currencyCode || 'USD';
        
        // Backwards compatibility: detect if price is in cents (e.g., "74995.0")
        var numPrice = parseFloat(priceValue);
        if (numPrice > 1000 && !isNaN(numPrice)) {
          // If price > 10000, almost certainly in cents (no product costs $10,000+ typically)
          // If price between 1000-10000, check if dividing by 100 gives reasonable value (< 1000)
          var majorUnits = numPrice / 100;
          if (numPrice > 10000 || (numPrice > 1000 && majorUnits < 1000 && majorUnits >= 1)) {
            numPrice = majorUnits;
          }
        }
        
        // Format using Intl.NumberFormat
        try {
          var formatter = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: currencyCode,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          });
          price.textContent = formatter.format(numPrice);
        } catch (e) {
          // Fallback if currency code is invalid
          price.textContent = currencyCode + ' ' + numPrice.toFixed(2);
        }
        
        cardInfo.appendChild(price);
      }

      card.appendChild(cardInfo);

      // Add click tracking
      card.addEventListener('click', function() {
        var sessionId = getSessionId();
        sendEvent('RECOMMENDATION_CLICKED', sessionId, {
          handle: product.handle || null,
          url: card.href || null,
          position: index + 1
        });

        // Persist last click so we can use it later for ATC attribution if we add a global script
        try {
          sessionStorage.setItem('editmuse_last_click', JSON.stringify({
            sid: sessionId,
            handle: product.handle || null,
            at: Date.now()
          }));
        } catch (e) {}
      });

      grid.appendChild(card);
      debug('Inserted product card', { title: product.title || product.handle });
    });

    debug('All products rendered, showing content. Total cards:', grid.children.length);
    showContent();
  }

  // Helper function to escape HTML
  function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showReasoning(reasoning, mode, error, productCount) {
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) return;
    
    var content = container.querySelector('[data-editmuse-content]');
    if (!content) return;
    
    var reasoningWrap = content.querySelector('[data-editmuse-reasoning-wrap]');
    if (!reasoningWrap) return;
    
    var reasoningEl = reasoningWrap.querySelector('[data-editmuse-reasoning]');
    if (!reasoningEl) return;
    
    // Check if reasoning should be shown
    var showReason = container.closest('.editmuse-results-wrapper');
    var shouldShow = showReason && 
      (getComputedStyle(showReason).getPropertyValue('--em-show-reason') || 'true').trim() !== 'false';
    
    if (!shouldShow) {
      reasoningWrap.style.display = 'none';
      debug('showReasoning: hidden (disabled)');
      return;
    }
    
    // Build enhanced reasoning text
    var reasoningText = '';
    
    // Detect fallback: ONLY treat as fallback if mode is explicitly set to fallback/placeholder
    // OR if there's an explicit error indicating fallback
    // Default to AI if mode is not explicitly fallback
    var isFallback = mode === 'placeholder' || mode === 'fallback';
    
    // If there's an error that suggests fallback, treat as fallback
    if (!isFallback && error) {
      var fallbackErrorPatterns = [
        'access token',
        'not available',
        'not configured',
        'Failed to fetch'
      ];
      var isFallbackError = fallbackErrorPatterns.some(function(pattern) {
        return error.toLowerCase().includes(pattern.toLowerCase());
      });
      if (isFallbackError) {
        isFallback = true;
        debug('showReasoning: detected fallback from error message:', error);
      }
    }
    
    debug('showReasoning: mode =', mode, 'isFallback =', isFallback, 'reasoning =', reasoning, 'error =', error);
    
    if (isFallback) {
      // Fallback mode - simple explanation
      reasoningText = '<div class="editmuse-reasoning-fallback">';
      reasoningText += '<strong>Note:</strong> ';
      
      if (productCount && productCount > 0) {
        reasoningText += 'We selected ' + productCount + ' product' + (productCount !== 1 ? 's' : '') + ' ';
        reasoningText += 'from our catalog based on availability and popularity.';
      } else {
        reasoningText += 'Products were selected from our catalog based on availability and popularity.';
      }
      
      reasoningText += '</div>';
      
      // Don't show the generic reasoning text in fallback mode - we already explained it above
      // Only show additional reasoning if it's not generic
      if (reasoning) {
        var genericPatterns = [
          'based on experience settings',
          'MVP: default selection',
          'Selected top products',
          'Selected.*products based on'
        ];
        var isGeneric = genericPatterns.some(function(pattern) {
          var regex = new RegExp(pattern, 'i');
          return regex.test(reasoning);
        });
        if (!isGeneric) {
          // Only show non-generic reasoning
          reasoningText += '<div class="editmuse-reasoning-detail">' + escapeHtml(reasoning) + '</div>';
        }
      }
    } else if (reasoning) {
      // Normal mode (AI-powered or saved result) with reasoning
      // Show the reasoning with AI label if it's not explicitly fallback
      reasoningText = '<div class="editmuse-reasoning-detail">';
      reasoningText += '<strong>AI-Powered Selection:</strong> ';
      reasoningText += escapeHtml(reasoning);
      if (productCount && productCount > 0) {
        reasoningText += ' These ' + productCount + ' product' + (productCount !== 1 ? 's were' : ' was') + ' ';
        reasoningText += 'intelligently ranked and selected based on your quiz responses, preferences, and product attributes.';
      }
      reasoningText += '</div>';
    } else {
      // Normal mode without reasoning - provide default explanation
      if (productCount && productCount > 0) {
        reasoningText = '<div class="editmuse-reasoning-detail">';
        reasoningText += 'These ' + productCount + ' product' + (productCount !== 1 ? 's were' : ' was') + ' ';
        reasoningText += 'carefully selected based on your quiz responses and preferences. ';
        reasoningText += 'Each recommendation matches the style, needs, and criteria you specified during the quiz.';
        reasoningText += '</div>';
      } else {
        reasoningText = '<div class="editmuse-reasoning-detail">';
        reasoningText += 'These recommendations were selected based on your quiz responses and preferences. ';
        reasoningText += 'Each product matches the style, needs, and criteria you specified.';
        reasoningText += '</div>';
      }
    }
    
      if (reasoningText) {
        reasoningEl.innerHTML = reasoningText;
        reasoningWrap.style.display = '';
        debug('showReasoning: displayed reasoning', { mode: mode, isFallback: isFallback });
      } else {
        reasoningWrap.style.display = 'none';
        debug('showReasoning: hidden (no reasoning available)');
      }
    }

  function loadResults() {
    // Per-container init guard
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) {
      debug('loadResults: container not found');
      return;
    }
    
    // Check if already initialized
    if (container.dataset.editmuseResultsInit === '1') {
      debug('loadResults: already initialized, skipping');
      return;
    }
    
    // Mark as initialized
    container.dataset.editmuseResultsInit = '1';
    debug('loadResults: initializing', { container: !!container });
    
    showLoading();
    var sessionId = getSessionId();

    debug('Current URL:', window.location.href);
    debug('URL search params:', window.location.search);
    debug('Extracted sessionId:', sessionId);

    if (!sessionId) {
      debug('No session ID found in URL or sessionStorage');
      showEmpty('No session found. Start from the launcher.');
      return;
    }

    debug('sid=', sessionId);
    
    // Build URL with sid - /apps/editmuse/session allows requests without signature (storefront direct call)
    // Don't include signature as it would be invalid (signature is HMAC of query params, which are different now)
    var url = '/apps/editmuse/session?sid=' + encodeURIComponent(sessionId);
    var currentParams = new URLSearchParams(window.location.search);
    var shop = currentParams.get('shop');
    // Only include shop if present, but don't include signature (route allows requests without it)
    if (shop) {
      url += '&shop=' + encodeURIComponent(shop);
    }
    debug('fetching', url);

    fetch(url, {
      credentials: 'same-origin'
    })
    .then(function(r) {
      debug('Response status:', r.status, r.statusText);
      if (!r.ok) {
        return r.json().then(function(data) {
          throw new Error(data.error || 'Failed to load results');
        });
      }
      return r.json();
    })
    .then(function(data) {
      debug('Parsed JSON:', data);
      
      // Check if we have products array (new format) or recommendations array (old format)
      var products = data.products || [];
      
      // Legacy support: if recommendations exist but products don't, convert recommendations
      if (products.length === 0 && data.recommendations && data.recommendations.length > 0) {
        // Old format - fetch product details from .js endpoint
        var productPromises = data.recommendations.map(function(item) {
          return fetch('/products/' + item.handle + '.js')
            .then(function(r) {
              if (!r.ok) throw new Error('Product not found');
              return r.json();
            })
            .then(function(product) {
              return {
                handle: item.handle,
                title: product.title || '',
                image: product.featured_image || null,
                price: product.variants && product.variants[0] ? product.variants[0].price : null,
                url: '/products/' + item.handle
              };
            })
            .catch(function(err) {
              debug('Error fetching product', item.handle, ':', err);
              return {
                handle: item.handle,
                title: item.handle,
                image: null,
                price: null,
                url: '/products/' + item.handle
              };
            });
        });
        
        Promise.all(productPromises).then(function(fetchedProducts) {
          renderProducts(fetchedProducts);
          
          // Fire RESULTS_VIEWED once after products render
          var sessionId = getSessionId();
          sendEvent('RESULTS_VIEWED', sessionId, {
            page: window.location.pathname,
            ref: document.referrer || null
          });
          
          // For legacy format, use mode from API if provided, otherwise default to null (treated as AI)
          var detectedMode = data.mode || null;
          showReasoning(data.reasoning, detectedMode, data.error, fetchedProducts.length);
        });
        return;
      }
      
      // New format: products array with full data
      debug('Products array length:', products.length);
      debug('Data ok:', data.ok, 'Status:', data.status, 'Mode:', data.mode);
      
      // Use mode from API if provided, otherwise default to null (will be treated as AI)
      // Only treat as fallback if mode is explicitly 'placeholder' or 'fallback'
      var detectedMode = data.mode || null;
      
      debug('API response - mode:', detectedMode, 'reasoning:', data.reasoning, 'error:', data.error);
      
      if (data.ok && products.length > 0) {
        debug('Rendering', products.length, 'products');
        renderProducts(products);
        
        // Fire RESULTS_VIEWED once after products render
        var sessionId = getSessionId();
        sendEvent('RESULTS_VIEWED', sessionId, {
          page: window.location.pathname,
          ref: document.referrer || null
        });
        showReasoning(data.reasoning, detectedMode, data.error, products.length);
      } else if (data.ok && products.length === 0) {
        debug('No products in response');
        if (data.status === 'PROCESSING') {
          showEmpty('Processing your recommendations. Please check back in a moment.');
        } else if (data.status === 'COLLECTING') {
          showEmpty('Session is still collecting information. Please complete the quiz first.');
        } else {
          showEmpty('No results available yet. Please check back soon.');
        }
      } else {
        debug('Invalid response or no products');
        showEmpty('No results available yet. Please check back soon.');
      }
    })
    .catch(function(e) {
      debug('Error:', e);
      showError(e.message || 'Unable to load results. Please try again.');
    });
  }

  // Initialize - handle DOM ready and Shopify re-renders
  function initResults() {
    var container = document.querySelector('[data-editmuse-results]');
    if (!container) {
      debug('initResults: container not found, will retry on DOMContentLoaded');
      return;
    }
    
    // Reset init flag if container was re-rendered (Shopify theme editor)
    // Check if container has grid with products (already initialized)
    if (container.dataset.editmuseResultsInit === '1') {
      var hasGrid = container.querySelector('[data-editmuse-grid]');
      if (hasGrid && hasGrid.children.length > 0) {
        // Already initialized with products, skip
        debug('initResults: already initialized with products, skipping');
        return;
      }
      // Grid missing or empty, likely re-rendered, reset flag
      if (!hasGrid || hasGrid.children.length === 0) {
        delete container.dataset.editmuseResultsInit;
        debug('initResults: container re-rendered, resetting init flag');
      }
    }
    
    // Fetch config first (cache it), then load results
    fetchShopConfig().then(function() {
      loadResults();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResults);
  } else {
    initResults();
  }
  
  // Re-init on Shopify section load/reorder (theme editor)
  document.addEventListener('shopify:section:load', function(e) {
    if (e.detail && e.detail.sectionId) {
      var section = document.querySelector('[data-section-id="' + e.detail.sectionId + '"]');
      if (section && section.querySelector('[data-editmuse-results]')) {
        debug('shopify:section:load detected, re-initializing');
        var container = section.querySelector('[data-editmuse-results]');
        if (container) {
          delete container.dataset.editmuseResultsInit;
          initResults();
        }
      }
    }
  });

  // Global add-to-cart tracking: include sid in add-to-cart events
  // This runs on all pages, not just results page
  (function() {
    var sessionId = getSessionId();
    if (!sessionId) {
      // Try to get from sessionStorage if not in URL
      try {
        sessionId = sessionStorage.getItem('editmuse_sid');
      } catch (e) {}
    }

    if (!sessionId) return; // No session ID available

    // Track add-to-cart via form submission
    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      
      var action = form.action || '';
      if (action.indexOf('/cart/add') === -1) return;

      // Get product handle from form if available
      var productHandle = null;
      try {
        var productInput = form.querySelector('input[name="id"], input[name="product_id"]');
        if (productInput) {
          // Try to get handle from data attributes or URL
          var productLink = form.closest('form')?.querySelector('a[href*="/products/"]');
          if (productLink) {
            var match = productLink.href.match(/\/products\/([^\/\?#]+)/);
            if (match) productHandle = match[1];
          }
        }
      } catch (e) {}

      // Send ADD_TO_CART_CLICKED event with sid
      sendEvent('ADD_TO_CART_CLICKED', sessionId, {
        handle: productHandle,
        source: 'form_submit'
      });

      // Add sid as hidden input to form (if form supports properties)
      try {
        var propertiesInput = form.querySelector('input[name="properties[_editmuse_sid]"]');
        if (!propertiesInput) {
          var sidInput = document.createElement('input');
          sidInput.type = 'hidden';
          sidInput.name = 'properties[_editmuse_sid]';
          sidInput.value = sessionId;
          form.appendChild(sidInput);
        }
      } catch (e) {}
    }, true); // Use capture phase

    // Track add-to-cart via fetch/XHR (AJAX cart)
    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function() {
        var url = arguments[0];
        var options = arguments[1] || {};
        
        if (typeof url === 'string' && (url.indexOf('/cart/add') !== -1 || url.indexOf('/cart/add.js') !== -1)) {
          // Send ADD_TO_CART_CLICKED event
          sendEvent('ADD_TO_CART_CLICKED', sessionId, {
            source: 'ajax',
            url: url
          });

          // Add sid to request body if it's a POST with JSON body
          if (options.method === 'POST' && options.body) {
            try {
              if (typeof options.body === 'string') {
                var body = JSON.parse(options.body);
                if (body && typeof body === 'object') {
                  if (!body.properties) body.properties = {};
                  body.properties._editmuse_sid = sessionId;
                  options.body = JSON.stringify(body);
                }
              }
            } catch (e) {
              // If body is not JSON, try FormData
              if (options.body instanceof FormData) {
                options.body.append('properties[_editmuse_sid]', sessionId);
              }
            }
          }
        }
        
        return originalFetch.apply(this, arguments);
      };
    }

    // Track checkout started events
    // Monitor for checkout button clicks and form submissions
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target) return;

      // Check if clicked element is a checkout button/link
      var checkoutButton = target.closest('a[href*="/checkout"], button[type="submit"][formaction*="/checkout"], [data-checkout], [name="add"][formaction*="/cart"], form[action*="/cart"] button[type="submit"]');
      if (!checkoutButton) {
        // Also check for common checkout button classes/text
        var text = (target.textContent || '').toLowerCase();
        if ((text.includes('checkout') || text.includes('buy now') || text.includes('purchase')) && 
            (target.tagName === 'BUTTON' || target.tagName === 'A' || target.closest('button') || target.closest('a'))) {
          checkoutButton = target.closest('button, a') || target;
        }
      }

      if (checkoutButton) {
        sendEvent('CHECKOUT_STARTED', sessionId, {
          source: 'click',
          element: checkoutButton.tagName || 'unknown'
        });
      }
    }, true); // Use capture phase

    // Track checkout form submissions
    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      
      var action = form.action || '';
      if (action.indexOf('/checkout') !== -1 || action.indexOf('/cart') !== -1) {
        // Check if this is a checkout/cart submission (not just add-to-cart)
        var isCheckout = action.indexOf('/checkout') !== -1 || 
                        (action.indexOf('/cart') !== -1 && !action.includes('/cart/add'));
        
        if (isCheckout) {
          sendEvent('CHECKOUT_STARTED', sessionId, {
            source: 'form_submit',
            action: action
          });
        }
      }
    }, true); // Use capture phase
  })();
})();
