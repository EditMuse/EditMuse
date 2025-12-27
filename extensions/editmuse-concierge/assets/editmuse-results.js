(function() {
  'use strict';

  // Mock data for when session is missing
  const mockProducts = [
    {
      id: 'mock-1',
      title: 'Classic White Shirt',
      price: '$89.00',
      image: 'https://via.placeholder.com/400x400?text=Product+1',
      url: '/products/classic-white-shirt'
    },
    {
      id: 'mock-2',
      title: 'Tailored Blazer',
      price: '$249.00',
      image: 'https://via.placeholder.com/400x400?text=Product+2',
      url: '/products/tailored-blazer'
    },
    {
      id: 'mock-3',
      title: 'Silk Scarf',
      price: '$65.00',
      image: 'https://via.placeholder.com/400x400?text=Product+3',
      url: '/products/silk-scarf'
    },
    {
      id: 'mock-4',
      title: 'Leather Handbag',
      price: '$395.00',
      image: 'https://via.placeholder.com/400x400?text=Product+4',
      url: '/products/leather-handbag'
    },
    {
      id: 'mock-5',
      title: 'Wool Coat',
      price: '$425.00',
      image: 'https://via.placeholder.com/400x400?text=Product+5',
      url: '/products/wool-coat'
    },
    {
      id: 'mock-6',
      title: 'Cashmere Sweater',
      price: '$185.00',
      image: 'https://via.placeholder.com/400x400?text=Product+6',
      url: '/products/cashmere-sweater'
    },
    {
      id: 'mock-7',
      title: 'Designer Jeans',
      price: '$165.00',
      image: 'https://via.placeholder.com/400x400?text=Product+7',
      url: '/products/designer-jeans'
    },
    {
      id: 'mock-8',
      title: 'Elegant Dress',
      price: '$295.00',
      image: 'https://via.placeholder.com/400x400?text=Product+8',
      url: '/products/elegant-dress'
    }
  ];

  function getSessionFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('session');
  }

  function getApiEndpoint() {
    // Try to get from block settings if available
    const container = document.querySelector('[data-editmuse-results]');
    if (container && container.dataset.apiEndpoint) {
      return container.dataset.apiEndpoint;
    }
    // Default placeholder endpoint
    return 'https://api.example.com/quiz/results';
  }

  function showLoading() {
    const container = document.querySelector('[data-editmuse-results]');
    if (!container) return;

    const loading = container.querySelector('.editmuse-results-loading');
    const content = container.querySelector('.editmuse-results-content');
    const error = container.querySelector('.editmuse-results-error');

    if (loading) loading.style.display = 'flex';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'none';
  }

  function showError() {
    const container = document.querySelector('[data-editmuse-results]');
    if (!container) return;

    const loading = container.querySelector('.editmuse-results-loading');
    const content = container.querySelector('.editmuse-results-content');
    const error = container.querySelector('.editmuse-results-error');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (error) error.style.display = 'flex';
  }

  function showContent() {
    const container = document.querySelector('[data-editmuse-results]');
    if (!container) return;

    const loading = container.querySelector('.editmuse-results-loading');
    const content = container.querySelector('.editmuse-results-content');
    const error = container.querySelector('.editmuse-results-error');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
    if (error) error.style.display = 'none';
  }

  function renderProducts(products) {
    const grid = document.querySelector('.editmuse-results-grid');
    if (!grid) return;

    grid.innerHTML = '';

    products.forEach(product => {
      const card = document.createElement('a');
      card.href = product.url || '#';
      card.className = 'editmuse-results-card';

      card.innerHTML = `
        <div class="editmuse-results-card-image-wrapper">
          <img 
            src="${product.image || ''}" 
            alt="${product.title || 'Product'}"
            class="editmuse-results-card-image"
            loading="lazy"
          />
        </div>
        <div class="editmuse-results-card-info">
          <h3 class="editmuse-results-card-title">${product.title || 'Product'}</h3>
          <div class="editmuse-results-card-price">${product.price || ''}</div>
          <span class="editmuse-results-card-link">View product</span>
        </div>
      `;

      grid.appendChild(card);
    });
  }

  async function fetchResults(session) {
    let url = getApiEndpoint();
    
    // Replace {session} placeholder if it exists, otherwise append as query param
    if (url.includes('{session}')) {
      url = url.replace('{session}', session || '');
    } else if (session) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}session=${encodeURIComponent(session)}`;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      // Expect data.products or data to be an array
      const products = data.products || data || [];
      
      // Ensure we have exactly 8 products (pad or slice as needed)
      const displayProducts = products.slice(0, 8);
      
      return displayProducts;
    } catch (error) {
      console.error('Error fetching results:', error);
      return null;
    }
  }

  function getResultsFromLocalStorage(session) {
    try {
      const stored = localStorage.getItem(`editmuse_quiz_${session}`);
      if (stored) {
        const data = JSON.parse(stored);
        return data.products || null;
      }
    } catch (error) {
      console.error('Error reading from localStorage:', error);
    }
    return null;
  }

  async function loadResults() {
    showLoading();

    const session = getSessionFromURL();

    let products = null;

    if (session) {
      // First, try to get from localStorage (for demo/fallback)
      products = getResultsFromLocalStorage(session);
      
      // If not in localStorage, try to fetch from API
      if (!products || products.length === 0) {
        products = await fetchResults(session);
      }
    }

    // If no session or fetch failed, use mock data
    if (!products || products.length === 0) {
      products = mockProducts;
    }

    if (products && products.length > 0) {
      renderProducts(products);
      showContent();
    } else {
      showError();
    }
  }

  // Initialize when DOM is ready
  function init() {
    const container = document.querySelector('[data-editmuse-results]');
    if (!container) return;

    loadResults();
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

