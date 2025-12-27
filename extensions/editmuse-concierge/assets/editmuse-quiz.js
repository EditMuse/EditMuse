(function() {
  'use strict';

  // Quiz steps configuration
  const quizSteps = [
    {
      id: 'occasion',
      title: 'What\'s the occasion?',
      type: 'select',
      options: [
        { value: 'work', label: 'Work' },
        { value: 'casual', label: 'Casual' },
        { value: 'formal', label: 'Formal Event' },
        { value: 'date', label: 'Date Night' },
        { value: 'travel', label: 'Travel' },
        { value: 'other', label: 'Other' }
      ]
    },
    {
      id: 'budget',
      title: 'What\'s your budget range?',
      type: 'select',
      options: [
        { value: 'under-100', label: 'Under $100' },
        { value: '100-250', label: '$100 - $250' },
        { value: '250-500', label: '$250 - $500' },
        { value: '500-1000', label: '$500 - $1,000' },
        { value: 'over-1000', label: 'Over $1,000' }
      ]
    },
    {
      id: 'sizes',
      title: 'What sizes do you wear?',
      type: 'multiselect',
      options: [
        { value: 'xs', label: 'XS' },
        { value: 's', label: 'S' },
        { value: 'm', label: 'M' },
        { value: 'l', label: 'L' },
        { value: 'xl', label: 'XL' },
        { value: 'xxl', label: 'XXL' }
      ]
    },
    {
      id: 'fit',
      title: 'What\'s your preferred fit?',
      type: 'select',
      options: [
        { value: 'slim', label: 'Slim' },
        { value: 'regular', label: 'Regular' },
        { value: 'relaxed', label: 'Relaxed' },
        { value: 'oversized', label: 'Oversized' }
      ]
    },
    {
      id: 'colours',
      title: 'What colours do you prefer?',
      type: 'multiselect',
      options: [
        { value: 'black', label: 'Black' },
        { value: 'white', label: 'White' },
        { value: 'navy', label: 'Navy' },
        { value: 'beige', label: 'Beige' },
        { value: 'grey', label: 'Grey' },
        { value: 'pastels', label: 'Pastels' },
        { value: 'bold', label: 'Bold Colours' },
        { value: 'neutral', label: 'Neutral Tones' }
      ]
    },
    {
      id: 'inspiration',
      title: 'Tell us more about your style',
      type: 'inspiration'
    }
  ];

  // Generate random session ID
  function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // Generate mock results based on quiz answers
  function generateMockResults(answers) {
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

    // Shuffle and return 8 products
    return mockProducts.sort(() => Math.random() - 0.5).slice(0, 8);
  }

  // Create quiz modal HTML
  function createQuizModal() {
    return `
      <div class="editmuse-quiz-modal" id="editmuse-quiz-modal">
        <div class="editmuse-quiz-modal-content">
          <button class="editmuse-quiz-modal-close" aria-label="Close modal">&times;</button>
          <div class="editmuse-quiz-progress">
            <div class="editmuse-quiz-progress-bar"></div>
          </div>
          <div class="editmuse-quiz-steps"></div>
          <div class="editmuse-quiz-navigation">
            <button type="button" class="editmuse-quiz-btn editmuse-quiz-btn-back" style="display: none;">Back</button>
            <button type="button" class="editmuse-quiz-btn editmuse-quiz-btn-next">Next</button>
            <button type="button" class="editmuse-quiz-btn editmuse-quiz-btn-submit" style="display: none;">Get my edit</button>
          </div>
        </div>
      </div>
    `;
  }

  // Render step content
  function renderStep(step, stepIndex, answers) {
    let html = `
      <div class="editmuse-quiz-step" data-step="${stepIndex}">
        <h2 class="editmuse-quiz-step-title">${step.title}</h2>
        <div class="editmuse-quiz-step-content">
    `;

    if (step.type === 'select') {
      html += `<select class="editmuse-quiz-select" name="${step.id}" data-required="true">`;
      html += `<option value="">Select an option...</option>`;
      step.options.forEach(option => {
        const selected = answers[step.id] === option.value ? 'selected' : '';
        html += `<option value="${option.value}" ${selected}>${option.label}</option>`;
      });
      html += `</select>`;
    } else if (step.type === 'multiselect') {
      html += `<div class="editmuse-quiz-multiselect">`;
      step.options.forEach(option => {
        const checked = answers[step.id] && answers[step.id].includes(option.value) ? 'checked' : '';
        html += `
          <label class="editmuse-quiz-checkbox-label">
            <input type="checkbox" name="${step.id}" value="${option.value}" ${checked} data-required="true">
            <span>${option.label}</span>
          </label>
        `;
      });
      html += `</div>`;
    } else if (step.type === 'inspiration') {
      html += `
        <div class="editmuse-quiz-inspiration">
          <label class="editmuse-quiz-upload-label">
            <span class="editmuse-quiz-upload-text">Upload an inspiration image (optional)</span>
            <input type="file" accept="image/*" class="editmuse-quiz-file-input" name="inspiration_image">
            <div class="editmuse-quiz-file-preview"></div>
          </label>
          <textarea 
            class="editmuse-quiz-textarea" 
            name="vibe_description" 
            placeholder="Describe your vibe..."
            rows="4"
          >${answers.vibe_description || ''}</textarea>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;

    return html;
  }

  // Initialize quiz
  function initQuiz() {
    const modal = document.getElementById('editmuse-quiz-modal');
    if (!modal) return;

    const stepsContainer = modal.querySelector('.editmuse-quiz-steps');
    const progressBar = modal.querySelector('.editmuse-quiz-progress-bar');
    const backBtn = modal.querySelector('.editmuse-quiz-btn-back');
    const nextBtn = modal.querySelector('.editmuse-quiz-btn-next');
    const submitBtn = modal.querySelector('.editmuse-quiz-btn-submit');
    const closeBtn = modal.querySelector('.editmuse-quiz-modal-close');

    let currentStep = 0;
    let answers = {};

    // Render all steps (initially hidden)
    stepsContainer.innerHTML = quizSteps.map((step, index) => 
      renderStep(step, index, answers)
    ).join('');

    // Show first step
    showStep(0);

    function showStep(stepIndex) {
      currentStep = stepIndex;
      const allSteps = stepsContainer.querySelectorAll('.editmuse-quiz-step');
      
      allSteps.forEach((step, index) => {
        step.style.display = index === stepIndex ? 'block' : 'none';
      });

      // Update progress bar
      const progress = ((stepIndex + 1) / quizSteps.length) * 100;
      progressBar.style.width = progress + '%';

      // Update navigation buttons
      backBtn.style.display = stepIndex > 0 ? 'inline-block' : 'none';
      
      if (stepIndex === quizSteps.length - 1) {
        nextBtn.style.display = 'none';
        submitBtn.style.display = 'inline-block';
      } else {
        nextBtn.style.display = 'inline-block';
        submitBtn.style.display = 'none';
      }
    }

    function validateStep(stepIndex) {
      const step = quizSteps[stepIndex];
      const stepElement = stepsContainer.querySelector(`[data-step="${stepIndex}"]`);

      if (step.type === 'select') {
        const select = stepElement.querySelector('select');
        if (select.hasAttribute('data-required') && !select.value) {
          select.classList.add('error');
          return false;
        }
        select.classList.remove('error');
        answers[step.id] = select.value;
      } else if (step.type === 'multiselect') {
        const checkboxes = stepElement.querySelectorAll('input[type="checkbox"]');
        const checked = Array.from(checkboxes).filter(cb => cb.checked);
        if (checkboxes[0].hasAttribute('data-required') && checked.length === 0) {
          checkboxes.forEach(cb => cb.classList.add('error'));
          return false;
        }
        checkboxes.forEach(cb => cb.classList.remove('error'));
        answers[step.id] = checked.map(cb => cb.value);
      } else if (step.type === 'inspiration') {
        const fileInput = stepElement.querySelector('input[type="file"]');
        const textarea = stepElement.querySelector('textarea');
        
        if (fileInput.files.length > 0) {
          answers.inspiration_image = fileInput.files[0];
        }
        answers.vibe_description = textarea.value;
      }

      return true;
    }

    function handleFileUpload(input) {
      const preview = input.closest('.editmuse-quiz-inspiration').querySelector('.editmuse-quiz-file-preview');
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
          preview.innerHTML = `<img src="${e.target.result}" alt="Preview" class="editmuse-quiz-preview-image">`;
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    // Navigation handlers
    backBtn.addEventListener('click', () => {
      if (currentStep > 0) {
        showStep(currentStep - 1);
      }
    });

    nextBtn.addEventListener('click', () => {
      if (validateStep(currentStep)) {
        if (currentStep < quizSteps.length - 1) {
          showStep(currentStep + 1);
        }
      }
    });

    submitBtn.addEventListener('click', () => {
      if (validateStep(currentStep)) {
        // Generate session ID
        const sessionId = generateSessionId();
        
        // Generate mock results
        const products = generateMockResults(answers);
        
        // Store in localStorage
        localStorage.setItem(`editmuse_quiz_${sessionId}`, JSON.stringify({
          session: sessionId,
          answers: answers,
          products: products,
          timestamp: Date.now()
        }));

        // Redirect to results page
        window.location.href = `/pages/style-quiz-results?session=${sessionId}`;
      }
    });

    // File upload handler
    const fileInputs = stepsContainer.querySelectorAll('.editmuse-quiz-file-input');
    fileInputs.forEach(input => {
      input.addEventListener('change', () => handleFileUpload(input));
    });
  }

  // Initialize when DOM is ready
  function init() {
    // Insert modal into body if not already present
    if (!document.getElementById('editmuse-quiz-modal')) {
      document.body.insertAdjacentHTML('beforeend', createQuizModal());
    }

    const modal = document.getElementById('editmuse-quiz-modal');
    const closeButton = modal.querySelector('.editmuse-quiz-modal-close');
    const triggers = document.querySelectorAll('[data-editmuse-quiz-trigger]');

    // Open modal on button click
    triggers.forEach(trigger => {
      trigger.addEventListener('click', function() {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        initQuiz();
      });
    });

    // Close modal on close button click
    closeButton.addEventListener('click', function() {
      closeModal();
    });

    // Close modal on backdrop click
    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        closeModal();
      }
    });

    // Close modal on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        closeModal();
      }
    });

    function closeModal() {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
