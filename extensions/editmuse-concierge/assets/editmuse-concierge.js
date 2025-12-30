console.log("[EditMuse] JS loaded");

// Global guard to prevent duplicate initialization
if (window.__EDITMUSE_INIT__) {
  console.log("[EditMuse] Already initialized, skipping");
} else {
  window.__EDITMUSE_INIT__ = true;

(function() {
  'use strict';

  var DEBUG = window.EDITMUSE_DEBUG || false;

  function log() {
    if (DEBUG) console.log.apply(console, ['[EditMuse]'].concat(Array.prototype.slice.call(arguments)));
  }

  // Get shop domain from Shopify global or meta tag
  function getShopDomain() {
    if (window.Shopify && window.Shopify.shop) {
      return window.Shopify.shop;
    }
    var meta = document.querySelector('meta[property="og:url"]');
    if (meta) {
      var match = meta.content.match(/https?:\/\/([^.]+\.myshopify\.com)/);
      if (match) return match[1];
    }
    return null;
  }

  // Launcher block: Delegated click handler (works with dynamic content)
  document.addEventListener('click', async function(e) {
    var btn = e.target.closest('[data-editmuse-launcher-btn]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    var wrap = btn.closest('[data-editmuse-launcher]');
    if (!wrap) {
      console.error('[EditMuse] Launcher wrapper not found');
      return;
    }

    var resultUrl = wrap.dataset.resultUrl || '/pages/editmuse-results';
    var resultCount = Number(wrap.dataset.resultCount || '8');

    console.log('[EditMuse] Launcher clicked', { 
      resultUrl: resultUrl, 
      resultCount: resultCount,
      dataset: wrap.dataset
    });
    console.log('[EditMuse] Starting session...');

    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'Loading...';

    // Hide any previous errors
    var errorMsg = wrap.querySelector('[data-editmuse-launcher-error]');
    if (errorMsg) errorMsg.style.display = 'none';

    // Get modal elements
    var modal = wrap.querySelector('.editmuse-concierge-modal');
    var questionTitle = modal ? modal.querySelector('[data-editmuse-question-title]') : null;
    var input = modal ? modal.querySelector('[data-editmuse-launcher-input]') : null;
    var nextBtn = modal ? modal.querySelector('[data-editmuse-launcher-next]') : null;
    var modalError = modal ? modal.querySelector('[data-editmuse-launcher-modal-error]') : null;
    var closeBtn = modal ? modal.querySelector('.editmuse-concierge-modal-close') : null;
    var overlay = modal ? modal.querySelector('.editmuse-concierge-modal-overlay') : null;

    if (!modal || !questionTitle || !input || !nextBtn) {
      console.error('[EditMuse] Modal elements not found');
      btn.disabled = false;
      btn.textContent = old;
      return;
    }

    try {
      // Include query params for App Proxy signature
      var proxyUrl = '/apps/editmuse/session/start' + window.location.search;
      console.log('[EditMuse] Fetching:', proxyUrl);

      var res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ resultCount: resultCount })
      });

      var data = await res.json().catch(function() { return {}; });
      console.log('[EditMuse] Session start response:', { status: res.status, data: data });

      if (!res.ok || !data.sessionId) {
        throw new Error(data.error || 'Failed to start session');
      }

      console.log('[EditMuse] Session started:', data.sessionId, 'First question:', data.firstQuestion);

      // Store sessionId on the wrapper
      wrap.dataset.sessionId = data.sessionId;
      wrap.dataset.resultUrl = resultUrl;

      // Update question title if provided
      if (data.firstQuestion) {
        questionTitle.textContent = data.firstQuestion;
      }

      // Clear input and errors
      if (input) input.value = '';
      if (modalError) modalError.style.display = 'none';

      // Open modal
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';

      // Re-enable button
      btn.disabled = false;
      btn.textContent = old;

      // Handle Next button click (only bind once per modal)
      if (!nextBtn.dataset.bound) {
        nextBtn.dataset.bound = 'true';
        nextBtn.addEventListener('click', async function(evt) {
          evt.preventDefault();
          var answerText = input.value.trim();
          if (!answerText) {
            if (modalError) {
              modalError.textContent = 'Please enter your answer';
              modalError.style.display = 'block';
            }
            return;
          }

          nextBtn.disabled = true;
          nextBtn.textContent = 'Loading...';
          if (modalError) modalError.style.display = 'none';

          try {
            var answerUrl = '/apps/editmuse/session/answer' + window.location.search;
            console.log('[EditMuse] Sending answer:', answerText);

            var answerRes = await fetch(answerUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ 
                sessionId: wrap.dataset.sessionId, 
                answer: answerText 
              })
            });

            var answerData = await answerRes.json().catch(function() { return {}; });
            console.log('[EditMuse] Answer response:', { status: answerRes.status, data: answerData });

            if (!answerRes.ok) {
              throw new Error(answerData.error || 'Failed to submit answer');
            }

            // Close modal
            modal.style.display = 'none';
            document.body.style.overflow = '';

            // Redirect to results
            var finalUrl = answerData.redirectUrl || (resultUrl + '?editmuse_session=' + encodeURIComponent(wrap.dataset.sessionId));
            console.log('[EditMuse] Redirecting to:', finalUrl);
            window.location.assign(finalUrl);
          } catch (err) {
            console.error('[EditMuse] Answer error', err);
            if (modalError) {
              modalError.textContent = String(err.message || err);
              modalError.style.display = 'block';
            }
            nextBtn.disabled = false;
            nextBtn.textContent = 'Next';
          }
        });
      }

      // Handle close button
      if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = 'true';
        closeBtn.addEventListener('click', function() {
          modal.style.display = 'none';
          document.body.style.overflow = '';
        });
      }

      // Handle overlay click
      if (overlay && !overlay.dataset.bound) {
        overlay.dataset.bound = 'true';
        overlay.addEventListener('click', function() {
          modal.style.display = 'none';
          document.body.style.overflow = '';
        });
      }

    } catch (err) {
      console.error('[EditMuse] Launcher error', err);
      btn.disabled = false;
      btn.textContent = old;
      // show an inline error
      if (!errorMsg) {
        errorMsg = document.createElement('div');
        errorMsg.setAttribute('data-editmuse-launcher-error', 'true');
        errorMsg.style.marginTop = '8px';
        errorMsg.style.fontSize = '14px';
        errorMsg.style.color = 'crimson';
        wrap.appendChild(errorMsg);
      }
      errorMsg.textContent = String(err.message || err);
      errorMsg.style.display = 'block';
    }
  }, true);

  // Concierge block: Single question, then redirect
  function initConcierge() {
    var concierge = document.querySelector('[data-editmuse-concierge]');
    if (!concierge) return;

    log('Initializing concierge block');
    var trigger = concierge.querySelector('[data-editmuse-concierge-trigger]');
    var modal = concierge.querySelector('.editmuse-concierge-modal');
    var closeBtn = modal ? modal.querySelector('.editmuse-concierge-modal-close') : null;
    var overlay = modal ? modal.querySelector('.editmuse-concierge-modal-overlay') : null;
    var nextBtn = concierge.querySelector('[data-editmuse-concierge-next]');
    var input = concierge.querySelector('[data-editmuse-concierge-input]');
    var errorEl = concierge.querySelector('[data-editmuse-concierge-error]');
    var resultUrl = concierge.getAttribute('data-result-url') || '/pages/editmuse-results';
    var resultCount = parseInt(concierge.getAttribute('data-result-count') || '8', 10);

    var sessionId = null;

    function showError(el, msg) {
      if (el) {
        el.textContent = msg;
        el.style.display = 'block';
      }
    }

    function hideError(el) {
      if (el) el.style.display = 'none';
    }

    if (trigger && modal) {
      trigger.addEventListener('click', function() {
        log('Concierge trigger clicked');
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        sessionId = null;
        if (input) input.value = '';
        hideError(errorEl);
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        if (modal) modal.style.display = 'none';
        document.body.style.overflow = '';
      });
    }

    if (overlay) {
      overlay.addEventListener('click', function() {
        if (modal) modal.style.display = 'none';
        document.body.style.overflow = '';
      });
    }

    if (nextBtn && input) {
      nextBtn.addEventListener('click', function(e) {
        e.preventDefault();
        log('Next button clicked');

        var text = input.value.trim();
        if (!text) {
          showError(errorEl, 'Please enter your request');
          return;
        }

        nextBtn.disabled = true;
        nextBtn.textContent = 'Loading...';
        hideError(errorEl);

        // Step 1: Start session if not started
        function startSession() {
          if (sessionId) {
            return Promise.resolve(sessionId);
          }

          log('Starting session');
          return fetch('/apps/editmuse/session/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ resultCount: resultCount })
          })
          .then(function(r) {
            if (!r.ok) {
              return r.json().then(function(data) {
                throw new Error(data.error || 'Failed to start session');
              });
            }
            return r.json();
          })
          .then(function(data) {
            if (data.ok && data.sessionId) {
              sessionId = data.sessionId;
              log('Session started:', sessionId);
              return sessionId;
            }
            throw new Error(data.error || 'Unknown error');
          });
        }

        // Step 2: Send answer
        function sendAnswer(sid) {
          log('Sending answer:', text);
          return fetch('/apps/editmuse/session/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId: sid, answer: text })
          })
          .then(function(r) {
            if (!r.ok) {
              return r.json().then(function(data) {
                throw new Error(data.error || 'Failed to send answer');
              });
            }
            return r.json();
          })
          .then(function(data) {
            if (data.ok) {
              log('Answer sent');
              return data;
            }
            throw new Error(data.error || 'Unknown error');
          });
        }

        // Execute flow
        startSession()
          .then(sendAnswer)
          .then(function(data) {
            log('Answer processed');
            if (data.done && data.redirectUrl) {
              window.location.href = data.redirectUrl;
            } else {
              window.location.href = resultUrl + '?editmuse_session=' + encodeURIComponent(sessionId);
            }
          })
          .catch(function(e) {
            log('Error:', e);
            showError(errorEl, e.message || 'Something went wrong. Please try again.');
            nextBtn.disabled = false;
            nextBtn.textContent = 'Next';
          });
      });
    }
  }

  // Results block: Load and display recommendations
  function initResults() {
    var results = document.querySelector('[data-editmuse-results]');
    if (!results) return;

    log('Initializing results block');
    var loading = results.querySelector('[data-editmuse-loading]');
    var content = results.querySelector('[data-editmuse-content]');
    var grid = results.querySelector('[data-editmuse-grid]');
    var empty = results.querySelector('[data-editmuse-empty]');
    var error = results.querySelector('[data-editmuse-error]');

    function showLoading() {
      if (loading) loading.style.display = 'block';
      if (content) content.style.display = 'none';
      if (empty) empty.style.display = 'none';
      if (error) error.style.display = 'none';
    }

    function showContent() {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'block';
      if (empty) empty.style.display = 'none';
      if (error) error.style.display = 'none';
    }

    function showEmpty() {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'none';
      if (empty) empty.style.display = 'block';
      if (error) error.style.display = 'none';
    }

    function showError() {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'none';
      if (empty) empty.style.display = 'none';
      if (error) error.style.display = 'block';
    }

    function renderProducts(products) {
      if (!grid) return;
      grid.innerHTML = '';
      
      if (!products || products.length === 0) {
        log('No products to render');
        if (empty) {
          empty.querySelector('p').textContent = 'No recommendations available yet.';
        }
        showEmpty();
        return;
      }

      log('Rendering', products.length, 'products');
      products.forEach(function(product) {
        var card = document.createElement('div');
        card.className = 'editmuse-product-card';
        
        var link = document.createElement('a');
        link.href = '/products/' + product.handle;
        link.className = 'editmuse-product-link';
        
        if (product.image) {
          var img = document.createElement('img');
          img.src = product.image;
          img.alt = product.title || '';
          img.className = 'editmuse-product-image';
          link.appendChild(img);
        }
        
        var title = document.createElement('h3');
        title.className = 'editmuse-product-title';
        title.textContent = product.title || '';
        link.appendChild(title);
        
        if (product.price) {
          var price = document.createElement('p');
          price.className = 'editmuse-product-price';
          price.textContent = '$' + parseFloat(product.price).toFixed(2);
          link.appendChild(price);
        }
        
        card.appendChild(link);
        grid.appendChild(card);
      });
      
      showContent();
    }

    // Get session ID from URL
    var params = new URLSearchParams(window.location.search);
    var sessionId = params.get('editmuse_session') || params.get('sid');

    if (!sessionId) {
      log('No session ID in URL');
      showEmpty();
      return;
    }

    log('Loading recommendations for session:', sessionId);
    showLoading();

    fetch('/apps/editmuse/session/result?sessionId=' + encodeURIComponent(sessionId), {
      credentials: 'same-origin'
    })
      .then(function(r) {
        log('Recommendations response:', r.status);
        if (!r.ok) {
          return r.json().then(function(data) {
            throw new Error(data.error || 'Failed to load recommendations');
          });
        }
        return r.json();
      })
      .then(function(data) {
        if (data.ok && data.recommendations) {
          renderProducts(data.recommendations);
        } else {
          log('Invalid response:', data);
          showError();
        }
      })
      .catch(function(e) {
        log('Error loading recommendations:', e);
        showError();
      });
  }

  // Initialize blocks (launcher uses delegated handler, so no init needed)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      initConcierge();
      initResults();
    });
  } else {
    initConcierge();
    initResults();
  }
})();

} // End of __EDITMUSE_INIT__ guard
