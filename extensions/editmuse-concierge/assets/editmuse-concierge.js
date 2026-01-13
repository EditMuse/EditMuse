(function() {
  'use strict';

  // Proxy URL helper - ensures all requests use Shopify app proxy base path
  const PROXY_BASE = '/apps/editmuse';
  const proxyUrl = (path) => {
    // Ensure path starts with /, then combine with PROXY_BASE
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    return PROXY_BASE + normalizedPath;
  };

  // Safe debug helper function
  function debugLog() {
    if (!window.EDITMUSE_DEBUG) return;
    if (console && console.log) {
      console.log.apply(console, ['[EditMuse]'].concat(Array.prototype.slice.call(arguments)));
    }
  }

  // Global submit lock to prevent duplicate submissions
  window.__EDITMUSE_SUBMIT_LOCK = window.__EDITMUSE_SUBMIT_LOCK || { inFlight: false, requestId: null, startedAt: 0 };

  // Debug helper: check if debug is enabled for a specific block
  function isDebug(blockEl) {
    return !!(window.EDITMUSE_DEBUG) || 
           (blockEl && blockEl.dataset && blockEl.dataset.editmuseDebug === 'true');
  }

  // Check if we're in Shopify Theme Editor design mode
  function isDesignMode() {
    return !!(window.Shopify && window.Shopify.designMode);
  }
  
  // ============================================
  // PRESET SYSTEM
  // ============================================
  
  // Brand Style Presets - complete design token sets
  var EM_PRESETS = {
    pop: {
      accent: "#7C3AED",
      accent2: "#06B6D4",
      useGradient: true,
      surface: "#FFFFFF",
      text: "#0B0B0F",
      mutedText: "rgba(11,11,15,0.62)",
      border: "rgba(11,11,15,0.14)",
      radius: 18,
      spacing: 16,
      fontScale: 1.04,
      shadow: "soft",
      overlayOpacity: 0.45,
      overlayBlur: 10,
      modalZ: 999999,
      buttonVariant: "solid",
      buttonRadius: 14,
      buttonSize: "medium",
      fullWidthButtons: false,
      buttonBg: "",
      buttonText: "#FFFFFF",
      modalStyle: "centered",
      modalMaxWidth: 760,
      showProgress: true,
      showClose: true,
      optionStyle: "pills",
      optionColumns: 2,
      stickyNav: true
    },
    minimal: {
      accent: "#111827",
      accent2: "#64748B",
      useGradient: false,
      surface: "#FFFFFF",
      text: "#0B0B0F",
      mutedText: "rgba(11,11,15,0.55)",
      border: "rgba(11,11,15,0.12)",
      radius: 12,
      spacing: 14,
      fontScale: 1.0,
      shadow: "none",
      overlayOpacity: 0.35,
      overlayBlur: 0,
      modalZ: 999999,
      buttonVariant: "outline",
      buttonRadius: 12,
      buttonSize: "medium",
      fullWidthButtons: false,
      buttonBg: "",
      buttonText: "#0B0B0F",
      modalStyle: "centered",
      modalMaxWidth: 720,
      showProgress: true,
      showClose: true,
      optionStyle: "pills",
      optionColumns: 1,
      stickyNav: false
    },
    luxe: {
      accent: "#111827",
      accent2: "#D4AF37",
      useGradient: false,
      surface: "#FFFFFF",
      text: "#0B0B0F",
      mutedText: "rgba(11,11,15,0.6)",
      border: "rgba(11,11,15,0.12)",
      radius: 16,
      spacing: 18,
      fontScale: 1.02,
      shadow: "strong",
      overlayOpacity: 0.55,
      overlayBlur: 14,
      modalZ: 999999,
      buttonVariant: "solid",
      buttonRadius: 14,
      buttonSize: "large",
      fullWidthButtons: false,
      buttonBg: "",
      buttonText: "#FFFFFF",
      modalStyle: "centered",
      modalMaxWidth: 800,
      showProgress: true,
      showClose: true,
      optionStyle: "cards",
      optionColumns: 2,
      stickyNav: true
    }
  };
  
  // Read block configuration from data attributes
  function readBlockConfig(rootEl) {
    if (!rootEl) return {};
    
    var config = {};
    
    // Helper to get attribute (tries both data-* and data-em-*)
    function getAttr(name) {
      return rootEl.getAttribute('data-' + name) || rootEl.getAttribute('data-em-' + name) || null;
    }
    
    // Brand style (required for preset selection)
    config.brandStyle = getAttr('brand-style') || rootEl.dataset.brandStyle || rootEl.dataset.emBrandStyle || 'pop';
    
    // Colors (strings - override if non-empty, trim first)
    var accent = getAttr('accent') || getAttr('accent-color');
    if (accent && String(accent).trim() !== '') config.accent = String(accent).trim();
    
    var accent2 = getAttr('accent2') || getAttr('accent-color-2');
    if (accent2 && String(accent2).trim() !== '') config.accent2 = String(accent2).trim();
    
    var surface = getAttr('surface') || getAttr('surface-color');
    if (surface && String(surface).trim() !== '') config.surface = String(surface).trim();
    
    var text = getAttr('text') || getAttr('text-color');
    if (text && String(text).trim() !== '') config.text = String(text).trim();
    
    var muted = getAttr('muted') || getAttr('muted-text-color');
    if (muted && String(muted).trim() !== '') config.mutedText = String(muted).trim();
    
    var border = getAttr('border') || getAttr('border-color');
    if (border && String(border).trim() !== '') config.border = String(border).trim();
    
    var btnBg = getAttr('btn-bg');
    if (btnBg && String(btnBg).trim() !== '') config.buttonBg = String(btnBg).trim();
    
    var btnText = getAttr('btn-text');
    if (btnText && String(btnText).trim() !== '') config.buttonText = String(btnText).trim();
    
    // Numbers (override if present)
    var radius = getAttr('radius');
    if (radius && radius !== '') config.radius = parseFloat(radius);
    
    var spacing = getAttr('spacing');
    if (spacing && spacing !== '') config.spacing = parseFloat(spacing);
    
    var fontScale = getAttr('font-scale');
    if (fontScale && fontScale !== '') config.fontScale = parseFloat(fontScale) / 100; // Convert % to decimal
    
    var overlayOpacity = getAttr('overlay-opacity');
    if (overlayOpacity && overlayOpacity !== '') config.overlayOpacity = parseFloat(overlayOpacity) / 100;
    
    var overlayBlur = getAttr('overlay-blur');
    if (overlayBlur && overlayBlur !== '') config.overlayBlur = parseFloat(overlayBlur);
    
    var modalZ = getAttr('modal-z') || getAttr('z');
    if (modalZ && modalZ !== '') config.modalZ = parseFloat(modalZ);
    
    var btnRadius = getAttr('btn-radius');
    if (btnRadius && btnRadius !== '') config.buttonRadius = parseFloat(btnRadius);
    
    var modalMaxWidth = getAttr('modal-maxw') || getAttr('modal-max-width');
    if (modalMaxWidth && modalMaxWidth !== '') config.modalMaxWidth = parseFloat(modalMaxWidth);
    
    var optionColumns = getAttr('option-columns');
    if (optionColumns && optionColumns !== '') config.optionColumns = parseInt(optionColumns, 10);
    
    // Booleans (override if explicitly set)
    var useGradient = getAttr('use-gradient');
    if (useGradient !== null) config.useGradient = useGradient === 'true';
    
    var showProgress = getAttr('show-progress') || getAttr('em-show-progress');
    if (showProgress !== null) config.showProgress = showProgress === 'true';
    
    var showClose = getAttr('show-close') || getAttr('em-show-close');
    if (showClose !== null) config.showClose = showClose === 'true';
    
    var btnFull = getAttr('btn-full') || getAttr('btn-full-width');
    if (btnFull !== null) config.fullWidthButtons = btnFull === 'true';
    
    var stickyNav = getAttr('sticky-nav');
    if (stickyNav !== null) config.stickyNav = stickyNav === 'true';
    
    // Enums (override if in allowed list)
    var shadowOptions = ['none', 'soft', 'medium', 'strong'];
    var shadow = getAttr('shadow') || getAttr('shadow-strength');
    if (shadow && shadowOptions.indexOf(shadow) !== -1) {
      config.shadow = shadow;
    }
    
    var buttonVariantOptions = ['solid', 'outline', 'glass'];
    var btnVariant = getAttr('btn-variant');
    if (btnVariant && buttonVariantOptions.indexOf(btnVariant) !== -1) {
      config.buttonVariant = btnVariant;
    }
    
    // Button size: Liquid uses 'sm'/'md'/'lg', but presets use 'small'/'medium'/'large'
    // Map Liquid values to preset values
    var btnSize = getAttr('btn-size');
    if (btnSize) {
      var sizeMap = {
        'sm': 'small',
        'md': 'medium',
        'lg': 'large',
        'small': 'small',
        'medium': 'medium',
        'large': 'large'
      };
      var mappedSize = sizeMap[btnSize.toLowerCase()];
      if (mappedSize) {
        config.buttonSize = mappedSize;
      }
    }
    
    var modalStyleOptions = ['centered', 'sheet', 'bottom_sheet'];
    var modalStyle = getAttr('modal-style');
    if (modalStyle && modalStyleOptions.indexOf(modalStyle) !== -1) {
      config.modalStyle = modalStyle;
    }
    
    var optionStyleOptions = ['pills', 'cards'];
    var optionStyle = getAttr('option-style');
    if (optionStyle && optionStyleOptions.indexOf(optionStyle) !== -1) {
      config.optionStyle = optionStyle;
    }
    
    // Motion (normal or reduced)
    var motionOptions = ['normal', 'reduced'];
    var motion = getAttr('motion');
    if (motion && motionOptions.indexOf(motion) !== -1) {
      config.motion = motion;
    }
    
    return config;
  }
  
  // Check if a value matches a preset from a DIFFERENT brand style (indicates leftover from previous style)
  function valueMatchesOtherPreset(key, value, currentBrandStyle) {
    if (value === null || value === undefined) return false;
    if (!currentBrandStyle) return false;
    
    // Check all presets EXCEPT the current one
    for (var presetName in EM_PRESETS) {
      if (EM_PRESETS.hasOwnProperty(presetName) && presetName !== currentBrandStyle) {
        var preset = EM_PRESETS[presetName];
        var presetValue = preset[key];
        
        if (presetValue === undefined) continue;
        
        // For strings: exact match (case-insensitive for colors)
        if (typeof value === 'string' && typeof presetValue === 'string') {
          if (value.toLowerCase().trim() === presetValue.toLowerCase().trim()) return true;
        }
        // For numbers: close match (within 0.001)
        else if (typeof value === 'number' && typeof presetValue === 'number') {
          if (Math.abs(value - presetValue) < 0.001) return true;
        }
        // For booleans: exact match
        else if (typeof value === 'boolean' && typeof presetValue === 'boolean') {
          if (value === presetValue) return true;
        }
      }
    }
    
    return false;
  }
  
  // Merge preset with merchant overrides (preset first, overrides replace if present AND different)
  function mergePresetWithOverrides(preset, overrides, currentBrandStyle) {
    if (!preset) return overrides || {};
    
    var merged = {};
    var key;
    
    // Start with preset
    for (key in preset) {
      if (preset.hasOwnProperty(key)) {
        merged[key] = preset[key];
      }
    }
    
    // Apply overrides (only if present/non-empty AND different from preset AND not from another preset)
    if (overrides) {
      for (key in overrides) {
        if (overrides.hasOwnProperty(key)) {
          var overrideValue = overrides[key];
          var presetValue = preset[key];
          
          // Skip brandStyle - it's used to select preset, not as an override
          if (key === 'brandStyle') continue;
          
          // Skip null, undefined, or empty strings (but keep valid falsy values like 0 and false)
          if (overrideValue === null || overrideValue === undefined) continue;
          if (typeof overrideValue === 'string' && overrideValue.trim() === '') continue;
          
          // For strings: override if non-empty AND different from preset AND not from another preset
          if (typeof overrideValue === 'string' && overrideValue !== '') {
            // Only override if:
            // 1. Different from current preset value
            // 2. NOT matching a preset value from another brand style (leftover from previous style)
            if (overrideValue !== presetValue && !valueMatchesOtherPreset(key, overrideValue, currentBrandStyle)) {
              merged[key] = overrideValue;
            }
          }
          // For numbers: override if not null/undefined AND different from preset AND not from another preset
          else if (typeof overrideValue === 'number' && overrideValue !== null && !isNaN(overrideValue)) {
            // Only override if different from preset (with small tolerance) AND not from another preset
            if (Math.abs(overrideValue - (presetValue || 0)) > 0.001 && !valueMatchesOtherPreset(key, overrideValue, currentBrandStyle)) {
              merged[key] = overrideValue;
            }
          }
          // For booleans: override if explicitly set AND different from preset
          else if (typeof overrideValue === 'boolean') {
            // Only override if different from preset (booleans are usually intentional)
            // But also check if it matches another preset (e.g., Pop has gradient=true, switching to Minimal should use gradient=false)
            if (overrideValue !== presetValue && !valueMatchesOtherPreset(key, overrideValue, currentBrandStyle)) {
              merged[key] = overrideValue;
            }
          }
          // For null (explicitly set to null means use preset)
          else if (overrideValue === null) {
            // Keep preset value
          }
        }
      }
    }
    
    return merged;
  }
  
  // Apply preset to root wrapper element (so button reflects brand style)
  function applyPresetToRoot(wrapperEl) {
    if (!wrapperEl) return;

    var overrides = readBlockConfig(wrapperEl);
    var brandStyle = overrides.brandStyle || wrapperEl.getAttribute('data-v2-brand-style') || wrapperEl.getAttribute('data-em-brand-style') || 'pop';
    var preset = (typeof EM_PRESETS !== 'undefined' && EM_PRESETS && EM_PRESETS[brandStyle]) ? EM_PRESETS[brandStyle] : (EM_PRESETS ? EM_PRESETS.pop : null);
    if (!preset) return;

    var cfg = mergePresetWithOverrides(preset, overrides, brandStyle);
    cfg.brandStyle = brandStyle;

    // Ensure attrs used by CSS selectors exist on root
    wrapperEl.setAttribute('data-v2-brand-style', brandStyle);
    wrapperEl.setAttribute('data-em-brand-style', brandStyle);

    // Apply core tokens to root style (so button changes)
    var s = wrapperEl.style;

    var accent = (cfg.accent && String(cfg.accent).trim() !== '') ? cfg.accent : (preset.accent || '#7C3AED');
    var accent2 = (cfg.accent2 && String(cfg.accent2).trim() !== '') ? cfg.accent2 : (preset.accent2 || '#06B6D4');

    safeSetVar(wrapperEl, '--em-accent', accent);
    safeSetVar(wrapperEl, '--em-accent2', accent2);
    safeSetVar(wrapperEl, '--em-accent-2', accent2);
    
    safeSetVar(wrapperEl, '--em-surface', cfg.surface);
    safeSetVar(wrapperEl, '--em-text', cfg.text);
    safeSetVar(wrapperEl, '--em-muted', cfg.mutedText);
    safeSetVar(wrapperEl, '--em-border', cfg.border);

    // Gradient on/off drives whether the root button is gradient
    s.setProperty('--em-gradient-on', cfg.useGradient ? '1' : '0');

    // Radius + spacing
    if (typeof cfg.radius === 'number') s.setProperty('--em-radius', cfg.radius + 'px');
    if (typeof cfg.spacing === 'number') {
      s.setProperty('--em-spacing', cfg.spacing + 'px');
      s.setProperty('--em-space', cfg.spacing + 'px');
    }

    // Button controls (these are used by your CSS selectors)
    if (cfg.buttonVariant) s.setProperty('--em-btn-variant', cfg.buttonVariant);
    if (typeof cfg.buttonRadius === 'number') s.setProperty('--em-btn-radius', cfg.buttonRadius + 'px');

    // IMPORTANT: do NOT set empty btn-bg (it breaks fallbacks). If empty, remove it.
    safeSetVar(wrapperEl, '--em-btn-bg', cfg.buttonBg);
    safeSetVar(wrapperEl, '--em-btn-text', cfg.buttonText);
    
    // Toggle reduced motion class
    if (cfg.motion === 'reduced') {
      wrapperEl.classList.add('em-motion--reduced');
    } else {
      wrapperEl.classList.remove('em-motion--reduced');
    }
  }
  
  // Safe CSS variable setter: never writes blank values
  function safeSetVar(el, name, value) {
    if (!el || value === null || value === undefined) return;
    var str = String(value).trim();
    if (str === '') {
      el.style.removeProperty(name);
      return;
    }
    el.style.setProperty(name, str);
  }
  
  // Final guard: ensure modal always has non-empty accent colors from root
  function ensureAccentsFromRoot(rootEl, modalEl) {
    if (!rootEl || !modalEl) return;

    var mcs = window.getComputedStyle(modalEl);
    var currentAccent = mcs.getPropertyValue('--em-accent').trim();
    var currentAccent2 = mcs.getPropertyValue('--em-accent2').trim();

    // Read from root computed style first
    var rcs = window.getComputedStyle(rootEl);
    var rootAccent = rcs.getPropertyValue('--em-accent').trim() || rootEl.getAttribute('data-em-accent-color') || '#7C3AED';
    var rootAccent2 = rcs.getPropertyValue('--em-accent2').trim() || rootEl.getAttribute('data-em-accent-color-2') || '#06B6D4';

    // Only fill if missing
    if (!currentAccent) safeSetVar(modalEl, '--em-accent', rootAccent);
    if (!currentAccent2) safeSetVar(modalEl, '--em-accent2', rootAccent2);

    // Keep alias synced
    var updatedA2 = window.getComputedStyle(modalEl).getPropertyValue('--em-accent2').trim();
    if (updatedA2) safeSetVar(modalEl, '--em-accent-2', updatedA2);

    // Also apply to inner wrapper if present
    var wrap = modalEl.querySelector('.editmuse-concierge-wrapper');
    if (wrap) {
      var wcs = window.getComputedStyle(wrap);
      if (!wcs.getPropertyValue('--em-accent').trim()) safeSetVar(wrap, '--em-accent', rootAccent);
      if (!wcs.getPropertyValue('--em-accent2').trim()) safeSetVar(wrap, '--em-accent2', rootAccent2);
      var wA2 = window.getComputedStyle(wrap).getPropertyValue('--em-accent2').trim();
      if (wA2) safeSetVar(wrap, '--em-accent-2', wA2);
    }
  }
  
  // Apply configuration to modal element
  function applyConfigToModal(modalEl, cfg, blockId) {
    if (!modalEl || !cfg) return;
    
    // Set brand style data attribute
    modalEl.dataset.brandStyle = cfg.brandStyle || 'pop';
    
    // Set brand style attributes for CSS selectors (both modal and inner wrapper)
    const brand = cfg.brandStyle || 'pop';
    modalEl.setAttribute('data-v2-brand-style', brand);
    modalEl.setAttribute('data-em-brand-style', brand);
    
    // Also set on inner wrapper if it exists
    const innerWrap = modalEl.querySelector('.editmuse-concierge-wrapper');
    if (innerWrap) {
      innerWrap.setAttribute('data-v2-brand-style', brand);
      innerWrap.setAttribute('data-em-brand-style', brand);
    }
    
    // Debug logging
    if (window.EDITMUSE_DEBUG) {
      debugLog('[EditMuse] APPLY CFG', {
        blockId: blockId,
        brandStyle: cfg.brandStyle,
        modalStyle: cfg.modalStyle,
        optionStyle: cfg.optionStyle,
        shadow: cfg.shadow,
        buttonVariant: cfg.buttonVariant,
        buttonSize: cfg.buttonSize,
        accent: cfg.accent,
        radius: cfg.radius,
        spacing: cfg.spacing,
        showProgress: cfg.showProgress,
        showClose: cfg.showClose,
        stickyNav: cfg.stickyNav,
        useGradient: cfg.useGradient
      });
    }
    
    // Toggle brand style classes
    modalEl.classList.remove('em-style-pop', 'em-style-minimal', 'em-style-luxe');
    modalEl.classList.add('em-style-' + (cfg.brandStyle || 'pop'));
    
    // Toggle modal style classes
    modalEl.classList.remove('em-modal-centered', 'em-modal-sheet', 'em-modal-bottom_sheet');
    if (cfg.modalStyle === 'sheet' || cfg.modalStyle === 'bottom_sheet') {
      modalEl.classList.add('em-modal-sheet', 'em-modal-bottom_sheet');
    } else {
      modalEl.classList.add('em-modal-centered');
    }
    
    // Toggle option style classes
    modalEl.classList.remove('em-options-pills', 'em-options-cards');
    modalEl.classList.add('em-options-' + (cfg.optionStyle || 'cards'));
    
    // Toggle shadow classes
    modalEl.classList.remove('em-shadow-none', 'em-shadow-soft', 'em-shadow-medium', 'em-shadow-strong');
    var shadowValue = cfg.shadow || 'soft';
    modalEl.classList.add('em-shadow-' + shadowValue);
    
    // Toggle button variant classes
    modalEl.classList.remove('em-btn-solid', 'em-btn-outline', 'em-btn-glass');
    modalEl.classList.add('em-btn-' + (cfg.buttonVariant || 'solid'));
    
    // Toggle button size classes
    modalEl.classList.remove('em-btn-small', 'em-btn-medium', 'em-btn-large');
    modalEl.classList.add('em-btn-' + (cfg.buttonSize || 'medium'));
    
    // Toggle sticky nav classes
    if (cfg.stickyNav) {
      modalEl.classList.remove('em-nav-static');
      modalEl.classList.add('em-nav-sticky');
    } else {
      modalEl.classList.remove('em-nav-sticky');
      modalEl.classList.add('em-nav-static');
    }
    
    // Set CSS variables
    var style = modalEl.style;
    
    // Set shadow CSS variable (for selector-based styling)
    style.setProperty('--em-shadow', shadowValue);
    
    // Always set accent colors with preset fallbacks (never blank)
    var preset = (typeof EM_PRESETS !== 'undefined' && EM_PRESETS && EM_PRESETS[brand]) ? EM_PRESETS[brand] : (EM_PRESETS ? EM_PRESETS.pop : null);

    var accent = (cfg.accent && String(cfg.accent).trim() !== '') ? cfg.accent : ((preset && preset.accent) ? preset.accent : '#7C3AED');
    var accent2 = (cfg.accent2 && String(cfg.accent2).trim() !== '') ? cfg.accent2 : ((preset && preset.accent2) ? preset.accent2 : '#06B6D4');

    safeSetVar(modalEl, '--em-accent', accent);
    safeSetVar(modalEl, '--em-accent2', accent2);
    safeSetVar(modalEl, '--em-accent-2', accent2);
    
    // Also apply to inner modal wrapper if it exists
    const wrap = modalEl.querySelector('.editmuse-concierge-wrapper');
    if (wrap) {
      safeSetVar(wrap, '--em-accent', accent);
      safeSetVar(wrap, '--em-accent2', accent2);
      safeSetVar(wrap, '--em-accent-2', accent2);
    }
    
    // Toggle reduced motion class on modal and inner wrapper
    if (cfg.motion === 'reduced') {
      modalEl.classList.add('em-motion--reduced');
      if (wrap) {
        wrap.classList.add('em-motion--reduced');
      }
    } else {
      modalEl.classList.remove('em-motion--reduced');
      if (wrap) {
        wrap.classList.remove('em-motion--reduced');
      }
    }
    
    safeSetVar(modalEl, '--em-surface', cfg.surface);
    safeSetVar(modalEl, '--em-text', cfg.text);
    safeSetVar(modalEl, '--em-muted', cfg.mutedText);
    safeSetVar(modalEl, '--em-border', cfg.border);
    if (cfg.radius !== null && cfg.radius !== undefined) style.setProperty('--em-radius', cfg.radius + 'px');
    if (cfg.spacing !== null && cfg.spacing !== undefined) style.setProperty('--em-space', cfg.spacing + 'px');
    if (cfg.fontScale !== null && cfg.fontScale !== undefined) style.setProperty('--em-font-scale', (cfg.fontScale * 100) + '%');
    if (cfg.overlayOpacity !== null && cfg.overlayOpacity !== undefined) style.setProperty('--em-overlay-opacity', cfg.overlayOpacity.toString());
    if (cfg.overlayBlur !== null && cfg.overlayBlur !== undefined) style.setProperty('--em-overlay-blur', cfg.overlayBlur + 'px');
    if (cfg.modalZ !== null && cfg.modalZ !== undefined) style.setProperty('--em-modal-z', cfg.modalZ.toString());
    if (cfg.modalMaxWidth !== null && cfg.modalMaxWidth !== undefined) style.setProperty('--em-modal-maxw', cfg.modalMaxWidth + 'px');
    if (cfg.buttonRadius !== null && cfg.buttonRadius !== undefined) style.setProperty('--em-btn-radius', cfg.buttonRadius + 'px');
    
    // Button background: use accent if empty
    var buttonBg = cfg.buttonBg || cfg.accent || '#7C3AED';
    safeSetVar(modalEl, '--em-btn-bg', buttonBg);
    
    safeSetVar(modalEl, '--em-btn-text', cfg.buttonText);
    
    // Option columns
    if (cfg.optionColumns !== null && cfg.optionColumns !== undefined) {
      style.setProperty('--em-option-cols', cfg.optionColumns.toString());
    }
    
    // Gradient toggle
    style.setProperty('--em-gradient-on', cfg.useGradient ? '1' : '0');
    
    // Show/hide progress bar
    // Default to true if not explicitly set to false
    var shouldShowProgress = cfg.showProgress !== false;
    
    // Set data attribute on modal for CSS selectors
    if (shouldShowProgress) {
      modalEl.removeAttribute('data-em-show-progress');
      modalEl.setAttribute('data-em-show-progress', 'true');
    } else {
      modalEl.setAttribute('data-em-show-progress', 'false');
    }
    
    var progressEl = modalEl.querySelector('[data-em-progress], .em-progress');
    if (progressEl) {
      if (shouldShowProgress) {
        // Show progress bar - remove inline display style to let CSS control it
        progressEl.style.display = '';
        progressEl.removeAttribute('style');
        progressEl.setAttribute('aria-hidden', 'false');
        if (window.EDITMUSE_DEBUG) {
          debugLog('[EditMuse] Progress bar shown', { blockId: blockId, shouldShowProgress: shouldShowProgress, cfgShowProgress: cfg.showProgress });
        }
      } else {
        // Hide progress bar
        progressEl.style.display = 'none';
        progressEl.setAttribute('aria-hidden', 'true');
        if (window.EDITMUSE_DEBUG) {
          debugLog('[EditMuse] Progress bar hidden', { blockId: blockId, shouldShowProgress: shouldShowProgress, cfgShowProgress: cfg.showProgress });
        }
      }
    } else {
      if (window.EDITMUSE_DEBUG) {
        debugLog('[EditMuse] Progress bar element not found in modal', { blockId: blockId });
      }
    }
    
    // Show/hide close button
    var closeBtn = modalEl.querySelector('.editmuse-concierge-modal-close');
    if (closeBtn) {
      if (cfg.showClose === false) {
        closeBtn.style.display = 'none';
      } else {
        closeBtn.style.display = '';
      }
    }
    
    // Update overlay opacity and blur
    // CSS variables are already set on modal element above (lines 358-359)
    // Overlay will inherit via CSS selectors, but we also set directly for immediate effect
    var overlayEl = modalEl.querySelector('.editmuse-concierge-modal-overlay');
    if (overlayEl) {
      // CSS variables are already set on modal, overlay inherits via CSS
      // But set directly on overlay too for immediate effect
      if (cfg.overlayOpacity !== null && cfg.overlayOpacity !== undefined) {
        overlayEl.style.setProperty('--em-overlay-opacity', cfg.overlayOpacity.toString());
        overlayEl.style.backgroundColor = 'rgba(0, 0, 0, ' + cfg.overlayOpacity.toString() + ')';
      }
      if (cfg.overlayBlur !== null && cfg.overlayBlur !== undefined) {
        overlayEl.style.setProperty('--em-overlay-blur', cfg.overlayBlur + 'px');
        overlayEl.style.backdropFilter = 'blur(' + cfg.overlayBlur + 'px)';
        overlayEl.style.webkitBackdropFilter = 'blur(' + cfg.overlayBlur + 'px)';
      }
    }
    
    // Ensure modal content also gets the CSS variables (it should inherit, but set explicitly for safety)
    var modalContent = modalEl.querySelector('.editmuse-concierge-modal-content');
    if (modalContent) {
      // Modal content inherits CSS variables from modal element, but ensure they're set
      // Most variables are already set on modalEl, content will inherit
      // But set key ones directly on content for brand style overrides
      var contentStyle = modalContent.style;
      if (cfg.radius !== null && cfg.radius !== undefined) {
        contentStyle.setProperty('--em-radius', cfg.radius + 'px');
      }
      safeSetVar(modalContent, '--em-surface', cfg.surface);
      safeSetVar(modalContent, '--em-text', cfg.text);
      safeSetVar(modalContent, '--em-border', cfg.border);
      if (cfg.modalMaxWidth !== null && cfg.modalMaxWidth !== undefined) {
        contentStyle.setProperty('--em-modal-maxw', cfg.modalMaxWidth + 'px');
      }
    }
    
    // Debug log - definitive log when preset is applied
    debugLog('[EditMuse] APPLY CFG', {
      blockId: blockId || 'unknown',
      brandStyle: cfg.brandStyle,
      modalStyle: cfg.modalStyle,
      optionStyle: cfg.optionStyle,
      accent: cfg.accent
    });
  }
  
  // Global instance registry: blockId -> ConciergeInstance
  var conciergeInstances = new Map();
  
  // Per-block state registry for Theme Editor resilience
  if (!window.__EDITMUSE_BLOCKS) {
    window.__EDITMUSE_BLOCKS = new Map();
  }
  
  // ConciergeInstance class - manages one block instance
  function ConciergeInstance(rootEl) {
    this.rootEl = rootEl;
    // Read block ID - prioritize data-editmuse-block-id for Theme Editor compatibility
    this.blockId = rootEl.getAttribute('data-editmuse-block-id') || rootEl.getAttribute('data-block-id') || rootEl.getAttribute('data-em-block-id') || rootEl.id;
    this.customElement = null;
    this.modalElement = null;
    this.abortController = new AbortController();
    
    // Read settings from root element (will be re-read on init)
    this.settings = {
      brandStyle: rootEl.getAttribute('data-em-brand-style') || rootEl.getAttribute('data-brand-style') || 'pop',
      modalStyle: rootEl.getAttribute('data-em-modal-style') || rootEl.getAttribute('data-modal-style') || 'centered',
      optionStyle: rootEl.getAttribute('data-em-option-style') || rootEl.getAttribute('data-option-style') || 'cards',
      showProgress: rootEl.getAttribute('data-em-show-progress') !== 'false',
      showClose: rootEl.getAttribute('data-em-show-close') !== 'false',
      stickyNav: rootEl.getAttribute('data-em-sticky-nav') !== 'false'
    };
    
    debugLog('[EditMuse] Instance created', this.blockId, this.settings);
  }
  
  ConciergeInstance.prototype.init = function() {
    var self = this;
    
    // Re-read settings from root element (in case Theme Editor changed them)
    this.settings = {
      brandStyle: this.rootEl.getAttribute('data-em-brand-style') || this.rootEl.getAttribute('data-brand-style') || 'pop',
      modalStyle: this.rootEl.getAttribute('data-em-modal-style') || this.rootEl.getAttribute('data-modal-style') || 'centered',
      optionStyle: this.rootEl.getAttribute('data-em-option-style') || this.rootEl.getAttribute('data-option-style') || 'cards',
      showProgress: this.rootEl.getAttribute('data-em-show-progress') !== 'false',
      showClose: this.rootEl.getAttribute('data-em-show-close') !== 'false',
      stickyNav: this.rootEl.getAttribute('data-em-sticky-nav') !== 'false'
    };
    
    debugLog('[EditMuse] Instance init', this.blockId, this.settings);
    
    // Find or wait for custom element
    var customEl = this.rootEl.querySelector('editmuse-concierge');
    if (!customEl) {
      // Wait for it to be added
      var observer = new MutationObserver(function(mutations) {
        customEl = self.rootEl.querySelector('editmuse-concierge');
        if (customEl) {
          observer.disconnect();
          self.customElement = customEl;
          self.setupCustomElement();
        }
      });
      observer.observe(this.rootEl, { childList: true, subtree: true });
      return;
    }
    
    this.customElement = customEl;
    this.setupCustomElement();
  };
  
  ConciergeInstance.prototype.setupCustomElement = function() {
    var self = this;
    var el = this.customElement;
    
    // Store reference to instance on element
    el._conciergeInstance = this;
    
    // Override moveModalToPortal to use our portal system
    var originalMoveModal = el.moveModalToPortal;
    if (originalMoveModal) {
      el.moveModalToPortal = function() {
        self.portalModal();
      };
    }
    
    // Find modal when it's rendered
    var modalObserver = new MutationObserver(function() {
      var modal = self.rootEl.querySelector('.editmuse-concierge-modal');
      if (modal && !modal.hasAttribute('data-em-portal-for')) {
        self.portalModal();
      }
    });
    modalObserver.observe(this.rootEl, { childList: true, subtree: true });
    
    // Initial check
    setTimeout(function() {
      var modal = self.rootEl.querySelector('.editmuse-concierge-modal');
      if (modal) {
        self.portalModal();
      }
    }, 100);
  };
  
  ConciergeInstance.prototype.portalModal = function() {
    var modal = this.rootEl.querySelector('.editmuse-concierge-modal');
    if (!modal) return;
    
    // Mark as portaled
    modal.setAttribute('data-em-portal-for', this.blockId);
    this.modalElement = modal;
    
    // Move to body if not already there
    if (modal.parentNode !== document.body) {
      document.body.appendChild(modal);
      
      // Copy CSS variables from root to modal
      var rootStyle = window.getComputedStyle(this.rootEl);
      var modalStyle = modal.style;
      var cssVars = [
        '--em-accent', '--em-accent2', '--em-surface', '--em-text', '--em-muted',
        '--em-border', '--em-radius', '--em-space', '--em-font-scale', '--em-shadow',
        '--em-overlay-opacity', '--em-overlay-blur', '--em-modal-z', '--em-btn-radius',
        '--em-btn-bg', '--em-btn-text', '--em-modal-maxw', '--em-option-cols'
      ];
      
      for (var i = 0; i < cssVars.length; i++) {
        var value = rootStyle.getPropertyValue(cssVars[i]).trim();
        if (value) {
          modalStyle.setProperty(cssVars[i], value);
        }
      }
      
      // Copy brand style class
      var brandStyle = this.settings.brandStyle;
      modal.classList.remove('em-style-pop', 'em-style-minimal', 'em-style-luxe');
      modal.classList.add('em-style-' + brandStyle);
      
      // Copy modal style class
      var modalStyleClass = this.settings.modalStyle === 'sheet' || this.settings.modalStyle === 'bottom_sheet' 
        ? 'em-modal-sheet' 
        : 'em-modal-centered';
      modal.classList.remove('em-modal-centered', 'em-modal-sheet');
      modal.classList.add(modalStyleClass);
      
      // Initially hide
      modal.classList.remove('show');
      modal.hidden = true;
    }
  };
  
  ConciergeInstance.prototype.destroy = function() {
    // Remove modal from body
    if (this.modalElement && this.modalElement.parentNode) {
      this.modalElement.remove();
    }
    
    // Abort any pending requests
    if (this.abortController) {
      this.abortController.abort();
    }
    
    // Clear references
    this.modalElement = null;
    this.customElement = null;
  };
  
  // Initialize all blocks on page - instance-safe with Theme Editor support
  function initAllBlocks() {
    // Safe query for all concierge blocks (loosened selector to work regardless of block-id attribute)
    var blocks = document.querySelectorAll('[data-editmuse-concierge]');
    
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var blockId = block.getAttribute('data-editmuse-block-id') || block.getAttribute('data-block-id') || block.getAttribute('data-em-block-id') || block.id;
      
      if (!blockId) {
        debugLog('[EditMuse] Skipping block without ID', block);
        continue;
      }
      
      // Apply preset to root wrapper (so button reflects brand style)
      applyPresetToRoot(block);
      
      // Destroy existing instance if it exists (important for Theme Editor re-renders)
      if (conciergeInstances.has(blockId)) {
        var oldInstance = conciergeInstances.get(blockId);
        if (oldInstance && typeof oldInstance.destroy === 'function') {
          oldInstance.destroy();
        }
        conciergeInstances.delete(blockId);
      }
      
      // Also clean up from global registry
      if (window.__EDITMUSE_BLOCKS && window.__EDITMUSE_BLOCKS.has(blockId)) {
        window.__EDITMUSE_BLOCKS.delete(blockId);
      }
      
      // Create new instance
      var instance = new ConciergeInstance(block);
      conciergeInstances.set(blockId, instance);
      window.__EDITMUSE_BLOCKS.set(blockId, {
        instance: instance,
        rootEl: block,
        initialized: true
      });
      
      instance.init();
      
      debugLog('[EditMuse] Block initialized', blockId);
    }
  }
  
  // Re-apply config to any open modals (for Theme Editor settings changes)
  function reapplyConfigToOpenModals() {
    var openModals = document.body.querySelectorAll('.editmuse-concierge-modal.show');
    for (var i = 0; i < openModals.length; i++) {
      var modal = openModals[i];
      var blockId = modal.getAttribute('data-em-portal-for') || modal.getAttribute('data-block-id');
      if (!blockId) continue;
      
      // Find the block root - try data-editmuse-block-id first for Theme Editor compatibility
      var blockRoot = document.querySelector('[data-editmuse-block-id="' + blockId + '"]') || 
                      document.querySelector('[data-block-id="' + blockId + '"]') ||
                      document.querySelector('[data-em-block-id="' + blockId + '"]');
      if (!blockRoot) {
        debugLog('[EditMuse] Could not find block root for modal', blockId);
        continue;
      }
      
      // Re-apply preset config
      var wrapperEl = blockRoot;
      var overrides = readBlockConfig(wrapperEl);
      var brandStyle = overrides.brandStyle || 'pop';
      var preset = EM_PRESETS[brandStyle] || EM_PRESETS.pop;
      var cfg = mergePresetWithOverrides(preset, overrides, brandStyle);
      cfg.brandStyle = brandStyle;
      
      applyConfigToModal(modal, cfg, blockId);
      
      // Final guard: ensure accents are never blank
      ensureAccentsFromRoot(wrapperEl, modal);
      
      debugLog('[EditMuse] Re-applied config to open modal', blockId);
    }
  }
  
  // Initialize a block based on data attributes and CSS variables (legacy function, kept for compatibility)
  function initEditMuseBlock(root) {
    if (!root || !root.hasAttribute('data-editmuse-root')) {
      return;
    }
    
    // Always re-initialize to pick up setting changes (don't skip if already initialized)
    root.dataset.emInit = '1';
    
    debugLog('[EditMuse] Block initialized (legacy)', root.getAttribute('data-em-block-id'));
  }
  
  // Populate debug panel with settings info (only if debug panel exists)
  function populateDebugPanel(root) {
    if (!root) return;
    var debugPre = root.querySelector('[data-em-debug-pre]');
    if (!debugPre) return; // Debug panel removed, so this will always return early
    
    try {
      var classes = Array.from(root.classList).filter(function(c) {
        return c.startsWith('em-') || c.startsWith('editmuse-');
      });
      
      var dataset = {};
      for (var key in root.dataset) {
        if (key.startsWith('em') || key.startsWith('editmuse')) {
          dataset[key] = root.dataset[key];
        }
      }
      
      var computedStyle = window.getComputedStyle(root);
      var cssVars = {
        '--em-accent': computedStyle.getPropertyValue('--em-accent').trim() || 'not set',
        '--em-accent2': computedStyle.getPropertyValue('--em-accent2').trim() || 'not set',
        '--em-surface': computedStyle.getPropertyValue('--em-surface').trim() || 'not set',
        '--em-text': computedStyle.getPropertyValue('--em-text').trim() || 'not set',
        '--em-muted': computedStyle.getPropertyValue('--em-muted').trim() || 'not set',
        '--em-border': computedStyle.getPropertyValue('--em-border').trim() || 'not set',
        '--em-radius': computedStyle.getPropertyValue('--em-radius').trim() || 'not set',
        '--em-space': computedStyle.getPropertyValue('--em-space').trim() || 'not set',
        '--em-font-scale': computedStyle.getPropertyValue('--em-font-scale').trim() || 'not set',
        '--em-overlay-opacity': computedStyle.getPropertyValue('--em-overlay-opacity').trim() || 'not set',
        '--em-overlay-blur': computedStyle.getPropertyValue('--em-overlay-blur').trim() || 'not set',
        '--em-modal-z': computedStyle.getPropertyValue('--em-modal-z').trim() || 'not set',
        '--em-btn-radius': computedStyle.getPropertyValue('--em-btn-radius').trim() || 'not set',
        '--em-btn-bg': computedStyle.getPropertyValue('--em-btn-bg').trim() || 'not set',
        '--em-btn-text': computedStyle.getPropertyValue('--em-btn-text').trim() || 'not set',
        '--em-modal-maxw': computedStyle.getPropertyValue('--em-modal-maxw').trim() || 'not set',
        '--em-option-cols': computedStyle.getPropertyValue('--em-option-cols').trim() || 'not set'
      };
      
      var debugInfo = {
        blockId: root.getAttribute('data-em-block-id') || 'unknown',
        classes: classes,
        dataset: dataset,
        cssVariables: cssVars
      };
      
      debugPre.textContent = JSON.stringify(debugInfo, null, 2);
    } catch (e) {
      debugPre.textContent = 'Error: ' + e.message;
    }
  }

  // Singleton modal root - created once and reused by all instances
  function getModalRoot() {
    var root = document.getElementById('editmuse-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'editmuse-modal-root';
      document.body.appendChild(root);
    }
    return root;
  }

  // Global modal registry: blockId -> modal element
  var modalRegistry = {};

  // Safely set aria-hidden on modal (removes focus first to avoid accessibility issues)
  function setModalAriaHidden(modal, hidden) {
    if (!modal) return;
    
    // If setting to hidden, first remove focus from any focused elements inside
    if (hidden) {
      var activeElement = document.activeElement;
      if (activeElement && modal.contains(activeElement)) {
        // Blur the focused element
        if (activeElement.blur) {
          activeElement.blur();
        }
        // Move focus to body as fallback
        if (document.body && document.body.focus) {
          document.body.focus();
        }
      }
    }
    
    modal.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  }

  // Close all modals
  function closeAllModals() {
    var modals = document.body.querySelectorAll('.editmuse-concierge-modal');
    for (var i = 0; i < modals.length; i++) {
      var modal = modals[i];
      modal.classList.remove('show');
      modal.hidden = true;
      setModalAriaHidden(modal, true);
    }
    // Unlock scroll if no modals are open
    var openModals = document.body.querySelectorAll('.editmuse-concierge-modal.show');
    if (openModals.length === 0) {
      document.body.style.overflow = '';
      document.documentElement.classList.remove('editmuse-modal-open');
    }
  }

  // Custom Element: EditMuse Concierge
  try {
    if (customElements.get('editmuse-concierge')) {
      console.warn('[EditMuse] Web component already registered');
    } else {
      customElements.define('editmuse-concierge', class EditMuseConcierge extends HTMLElement {
    constructor() {
      super();
      
      // State object - single source of truth
      this.state = {
        open: false,
        questions: [],
        current: 0,
        answers: [], // answers[stepIndex] = answer value
        mode: 'hybrid', // 'hybrid' | 'quiz' | 'chat'
        sessionId: null,
        loading: false,
        error: null
      };
      
      // Quiz answers storage (for backward compatibility and step restoration)
      this.quizAnswers = {};

      // AbortController for cleanup
      this.abortController = null;
      
      // Reference to modal element (for portal management)
      this.modalElement = null;
      
      // Shadow DOM not used - we render into light DOM for CSS compatibility
    }
    
    // ============================================
    // CENTRAL FUNCTIONS (Unified for text + select)
    // ============================================
    
    // Get step element by index
    getStepEl(stepIndex) {
      if (!this.modalElement) return null;
      return this.modalElement.querySelector('.editmuse-concierge-step[data-step="' + stepIndex + '"]');
    }
    
    // Get answer from step element (works for text OR select)
    getStepAnswer(stepEl) {
      if (!stepEl) return null;
      
      var question = this.state.questions[this.state.current];
      if (!question) return null;
      
      // For select questions: check state first, then radio/select DOM
      if (question.type === 'select') {
        // Check state first (most reliable)
        var stateAnswer = this.state.answers[this.state.current];
        if (stateAnswer) return stateAnswer;
        
        // Fallback: check radio buttons
        var checkedRadio = stepEl.querySelector('input[type="radio"]:checked');
        if (checkedRadio) return checkedRadio.value;
        
        // Fallback: check mobile select
        var select = stepEl.querySelector('[data-em-select]');
        if (select && select.value) return select.value;
        
        return null;
      }
      
      // For text questions: check state first, then input DOM
      var stateAnswer = this.state.answers[this.state.current];
      if (stateAnswer) return stateAnswer;
      
      // Fallback: read from text input
      var textInput = stepEl.querySelector('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]');
      if (textInput && textInput.value.trim() !== '') {
        return textInput.value.trim();
      }
      
      return null;
    }
    
    // Set answer for step (works for text OR select)
    setStepAnswer(stepIndex, value) {
      this.state.answers[stepIndex] = value;
      this.quizAnswers[stepIndex] = value;
      
      if (window.EDITMUSE_DEBUG) {
        debugLog('[EditMuse] setStepAnswer', { stepIndex: stepIndex, value: value });
      }
    }
    
    // Validate step (returns boolean)
    validateStep(stepEl) {
      if (!stepEl) return false;
      
      var answer = this.getStepAnswer(stepEl);
      if (!answer) return false;
      
      // For text, ensure non-empty string
      if (typeof answer === 'string' && answer.trim() === '') return false;
      
      return true;
    }
    
    // Update navigation state (enables/disables Next/Submit, sets button label)
    updateNavState() {
      if (!this.modalElement) return;
      
      var currentStepEl = this.getStepEl(this.state.current);
      var isValid = this.validateStep(currentStepEl);
      var isLastStep = this.state.current === this.state.questions.length - 1;
      var nextBtn = this.modalElement.querySelector('[data-editmuse-next]');
      
      if (nextBtn) {
        // Update button text
        var buttonText = isLastStep ? 'Submit' : 'Next';
        if (nextBtn.textContent.trim() !== buttonText) {
          nextBtn.textContent = buttonText;
        }
        
        // Update disabled state
        nextBtn.disabled = !isValid;
        if (isValid) {
          nextBtn.removeAttribute('disabled');
          nextBtn.style.pointerEvents = 'auto';
          nextBtn.style.cursor = 'pointer';
        } else {
          nextBtn.setAttribute('disabled', 'disabled');
          nextBtn.style.pointerEvents = 'none';
          nextBtn.style.cursor = 'not-allowed';
        }
      }
      
      if (window.EDITMUSE_DEBUG) {
        debugLog('[EditMuse] updateNavState', {
          currentStep: this.state.current,
          totalSteps: this.state.questions.length,
          isLastStep: isLastStep,
          isValid: isValid,
          nextDisabled: nextBtn ? nextBtn.disabled : 'N/A',
          buttonText: nextBtn ? nextBtn.textContent : 'N/A'
        });
      }
    }
    
    // Update progress bar
    updateProgressBar() {
      if (!this.modalElement) return;
      
      var totalSteps = this.state.questions ? this.state.questions.length : 0;
      if (totalSteps === 0) return;
      
      // Check if progress should be shown
      var wrapperEl = this.getWrapperElement();
      var showProgress = wrapperEl ? (wrapperEl.getAttribute('data-em-show-progress') !== 'false') : true;
      if (!showProgress) return;
      
      var progressPercent = ((this.state.current + 1) / totalSteps) * 100;
      
      // Update progress bar element if it exists
      var progressBar = this.modalElement.querySelector('[data-editmuse-progress-bar]');
      if (progressBar) {
        progressBar.style.width = progressPercent + '%';
      }
      
      // Also update em-progress-bar if it exists (legacy)
      var legacyProgressBar = this.modalElement.querySelector('.em-progress-bar');
      if (legacyProgressBar) {
        legacyProgressBar.style.width = progressPercent + '%';
      }
      
      // Update CSS custom property
      this.modalElement.style.setProperty('--em-progress', String((this.state.current + 1) / totalSteps));
    }

    connectedCallback() {
      debugLog('EditMuse Concierge connected', this);
      
      // Guard: prevent duplicate binding
      if (this.dataset.editmuseBound === '1') {
        debugLog('Block already bound, skipping', this);
        return;
      }
      this.dataset.editmuseBound = '1';
      
      // Initialize the root wrapper with data attributes
      var rootWrapper = this.getWrapperElement();
      if (rootWrapper && rootWrapper.hasAttribute('data-editmuse-root')) {
        initEditMuseBlock(rootWrapper);
      }
      
      // Generate unique block ID
      if (!this.blockId) {
        var blockIdAttr = rootWrapper ? (rootWrapper.getAttribute('data-block-id') || rootWrapper.getAttribute('data-em-block-id')) : null;
        this.blockId = blockIdAttr || 'editmuse-block-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      }
      
      // Set up event delegation once
      this.setupEventDelegation();
      
      // Render initial UI
      this.render();
      
      // Move modal to portal if it exists (this will copy all classes and CSS vars)
      this.moveModalToPortal();
      
      // Auto-open if configured (only on storefront, not in design mode)
      var openOnLoad = rootWrapper ? rootWrapper.getAttribute('data-em-open-on-load') : this.getAttribute('open-on-load');
      if (openOnLoad === 'true' && !isDesignMode()) {
        // Use data-editmuse-block-id for Theme Editor compatibility
        var blockId = rootWrapper ? (rootWrapper.getAttribute('data-editmuse-block-id') || rootWrapper.getAttribute('data-block-id') || rootWrapper.getAttribute('data-em-block-id')) : this.blockId;
        if (blockId) {
        var openedKey = 'em_opened_' + blockId;
        if (!sessionStorage.getItem(openedKey)) {
          sessionStorage.setItem(openedKey, '1');
          setTimeout(() => this.handleStart(), 100);
          }
        }
      }
    }

    disconnectedCallback() {
      debugLog('EditMuse Concierge disconnected');
      
      // Clean up event listeners
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      
      // Remove modal from portal if it exists
      if (this.modalElement && this.modalElement.parentNode) {
        // Remove the handlers bound flag so it can be re-set if component reconnects
        if (this.modalElement.dataset) {
          delete this.modalElement.dataset.editmuseHandlersBound;
        }
        this.modalElement.remove();
        this.modalElement = null;
      }
      
      // Unlock body scroll
          document.body.style.overflow = '';
      document.documentElement.classList.remove('editmuse-modal-open');
    }
    
    // Get the wrapper element (parent with data-editmuse-root)
    getWrapperElement() {
      var el = this;
      // Walk up to find the wrapper
      while (el && el.parentNode) {
        if (el.hasAttribute && el.hasAttribute('data-editmuse-root')) {
          return el;
        }
        el = el.parentNode;
      }
      // Fallback: return parent or self
      return this.parentNode || this;
    }
    
    // Copy ALL V2 CSS variables from block wrapper to modal
    applyThemeVars(blockWrapperEl, modalEl) {
      // All V2 theme variables
      var THEME_VARS = [
        '--em-accent',
        '--em-accent2',
        '--em-accent-2',
        '--em-gradient-on',
        '--em-surface',
        '--em-text',
        '--em-muted',
        '--em-border',
        '--em-radius',
        '--em-space',
        '--em-spacing',
        '--em-font-scale',
        '--em-shadow',
        '--em-z',
        '--em-modal-z',
        '--em-overlay',
        '--em-overlay-opacity',
        '--em-blur',
        '--em-overlay-blur',
        '--em-motion',
        '--em-btn-variant',
        '--em-btn-radius',
        '--em-btn-size',
        '--em-btn-full',
        '--em-btn-bg',
        '--em-btn-text',
        '--em-modal-style',
        '--em-modal-maxw',
        '--em-progress',
        '--em-close',
        '--em-option-style',
        '--em-option-cols',
        '--em-sticky-nav',
        '--em-badge',
        '--em-cta'
      ];
      
      if (!blockWrapperEl || !modalEl) {
        debugLog('[EditMuse] applyThemeVars: missing elements', { blockWrapperEl: !!blockWrapperEl, modalEl: !!modalEl });
        return;
      }
      
      var computedStyle = window.getComputedStyle(blockWrapperEl);
      var vars = {};
      
      for (var i = 0; i < THEME_VARS.length; i++) {
        var varName = THEME_VARS[i];
        var value = computedStyle.getPropertyValue(varName);
        if (value) {
          var trimmedValue = value.trim();
          safeSetVar(modalEl, varName, trimmedValue);
          if (trimmedValue !== '') {
            vars[varName] = trimmedValue;
          }
        }
      }
      
      // Alias-copy: ensure both accent2 variants exist
      if (!vars['--em-accent2'] && vars['--em-accent-2']) {
        safeSetVar(modalEl, '--em-accent2', vars['--em-accent-2']);
        vars['--em-accent2'] = vars['--em-accent-2'];
      } else if (!vars['--em-accent-2'] && vars['--em-accent2']) {
        safeSetVar(modalEl, '--em-accent-2', vars['--em-accent2']);
        vars['--em-accent-2'] = vars['--em-accent2'];
      }
      
      // Alias-copy: ensure --em-space exists (derive from --em-spacing if needed)
      if (!vars['--em-space'] && vars['--em-spacing']) {
        modalEl.style.setProperty('--em-space', vars['--em-spacing']);
        vars['--em-space'] = vars['--em-spacing'];
      }
      
      // Also copy data attributes for brand style (with fallbacks)
      var brandStyle =
        blockWrapperEl.getAttribute('data-v2-brand-style') ||
        blockWrapperEl.getAttribute('data-em-brand-style') ||
        blockWrapperEl.getAttribute('data-brand-style') ||
        blockWrapperEl.getAttribute('data-em-brand');
      if (brandStyle) {
        modalEl.setAttribute('data-v2-brand-style', brandStyle);
      }
      
      if (isDebug(blockWrapperEl)) {
        debugLog('[EditMuse] POP theme applied', {
          accent: vars['--em-accent'],
          accent2: vars['--em-accent-2'],
          modalMaxWidth: vars['--em-modal-maxw'],
          gradientOn: vars['--em-gradient-on'],
          brandStyle: brandStyle
        });
      }
    }
    
    // Move modal element to portal (document.body) and set up event delegation on modal
    moveModalToPortal() {
      // Try to find modal in custom element first
      var modal = this.querySelector('.editmuse-concierge-modal');
      
      // If not found, try to find it in portal by blockId
      if (!modal && this.blockId) {
        modal = document.body.querySelector('[data-em-portal-for="' + this.blockId + '"]');
      }
      
              if (modal) {
        // Ensure modalElement is set
        this.modalElement = modal;
        var wrapperEl = this.getWrapperElement();
        // Use data-editmuse-block-id for Theme Editor compatibility
        var blockId = this.blockId || (wrapperEl && (wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id')));
        if (blockId) {
          modal.setAttribute('data-block-id', blockId);
          modal.setAttribute('data-em-portal-for', blockId);
        }
        
        // Move to document.body if not already there
        if (modal.parentNode !== document.body) {
          document.body.appendChild(modal);
        }
        
        // Apply preset system immediately after portaling
        if (wrapperEl) {
          var finalBlockId = blockId || wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id');
          this.applyPresetToModal(modal, wrapperEl, finalBlockId);
        }
        
        // Register modal in global registry
        if (blockId) {
          modalRegistry[blockId] = modal;
        }
        
        // Set up event delegation on the modal element itself (since it's now in portal)
        // Only set up once (check for data attribute to prevent duplicates)
        if (!modal.dataset.editmuseHandlersBound) {
          this.setupModalEventDelegation(modal);
          modal.dataset.editmuseHandlersBound = 'true';
        }
        
        // Initially hide modal using class (not inline style) - but only if not already open
        // Check state.open to determine if modal should be visible
        if (!this.state || !this.state.open) {
          modal.classList.remove('show');
          modal.hidden = true;
          setModalAriaHidden(modal, true);
        } else {
          // If state is open, ensure modal is visible
          modal.classList.add('show');
          modal.hidden = false;
          setModalAriaHidden(modal, false);
        }
        
        debugLog('[EditMuse] Modal portaled', blockId);
      } else {
        debugLog('[EditMuse] No modal found to portal', this.blockId);
      }
    }
    
    // Apply preset system to modal
    applyPresetToModal(modalEl, wrapperEl, blockId) {
      if (!modalEl || !wrapperEl) return;
      
      // Read block configuration
      var overrides = readBlockConfig(wrapperEl);
      
      // Get brand style (required for preset selection)
      var brandStyle = overrides.brandStyle || 'pop';
      
      // Get preset
      var preset = EM_PRESETS[brandStyle] || EM_PRESETS.pop;
      
      // Merge preset with overrides (ignores values that match any preset)
      var cfg = mergePresetWithOverrides(preset, overrides, brandStyle);
      cfg.brandStyle = brandStyle; // Ensure brand style is set
      
      // Debug logging
      if (window.EDITMUSE_DEBUG) {
        debugLog('[EditMuse] Preset applied', {
          blockId: blockId,
          brandStyle: brandStyle,
          presetAccent: preset.accent,
          overrideAccent: overrides.accent,
          finalAccent: cfg.accent,
          presetRadius: preset.radius,
          overrideRadius: overrides.radius,
          finalRadius: cfg.radius
        });
      }
      
      // Copy theme vars from root to modal first
      this.applyThemeVars(wrapperEl, modalEl);
      
      // Apply configuration to modal
      applyConfigToModal(modalEl, cfg, blockId);
      
      // Final guard: ensure accents are never blank
      ensureAccentsFromRoot(wrapperEl, modalEl);
    }
    
    // Set up event delegation on modal element (for portal)
    setupModalEventDelegation(modal) {
      if (!this.abortController) return;
      var signal = this.abortController.signal;
      
      // Click handler on modal element
      modal.addEventListener('click', (e) => {
        var target = e.target;
        
        // Start button (shouldn't be in modal, but handle just in case)
        if (target.matches('[data-editmuse-start]') || target.closest('[data-editmuse-start]')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleStart();
          return;
        }

        // Next/Submit button
        var nextBtn = target.closest('[data-editmuse-next]');
        if (nextBtn && !nextBtn.disabled && !nextBtn.hasAttribute('disabled')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleNext();
          return;
        }

        // Back button
        var backBtn = target.closest('[data-editmuse-back]');
        if (backBtn && !backBtn.disabled && !backBtn.hasAttribute('disabled')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleBack();
          return;
        }

        // Option pill clicks - unified selection
        var pill = target.closest('[data-em-option]');
        if (pill) {
          e.preventDefault();
          e.stopPropagation();
          var value = pill.getAttribute('data-value') || pill.dataset.value;
          if (value) {
            // Set answer using unified function
            this.setStepAnswer(this.state.current, value);
            
            // Update radio button checked state
            var radio = pill.querySelector('input[type="radio"]');
            if (radio) {
              // Uncheck all radios in this step
              var stepEl = this.getStepEl(this.state.current);
              if (stepEl) {
                var allRadios = stepEl.querySelectorAll('input[type="radio"]');
                for (var i = 0; i < allRadios.length; i++) {
                  allRadios[i].checked = false;
                }
                radio.checked = true;
              }
            }
            
            // Update mobile select if exists
            var select = this.modalElement ? this.modalElement.querySelector('[data-em-select]') : null;
            if (select) {
              select.value = value;
            }
            
            // Update pill selected state (add/remove classes)
            var stepEl = this.getStepEl(this.state.current);
            if (stepEl) {
              var allPills = stepEl.querySelectorAll('[data-em-option]');
              for (var i = 0; i < allPills.length; i++) {
                allPills[i].classList.remove('selected', 'is-selected');
                allPills[i].setAttribute('aria-checked', 'false');
                allPills[i].setAttribute('aria-pressed', 'false');
              }
              pill.classList.add('selected', 'is-selected');
              pill.setAttribute('aria-checked', 'true');
              pill.setAttribute('aria-pressed', 'true');
            }
            
            // Update navigation state
            this.updateNavState();
            
            if (window.EDITMUSE_DEBUG) {
              debugLog('[EditMuse] Option selected', { value: value, currentStep: this.state.current });
            }
          }
          return;
        }

        // Close button
        if (target.matches('.editmuse-concierge-modal-close') || target.closest('.editmuse-concierge-modal-close')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleClose();
          return;
        }

        // Overlay click (close modal) - check if click is on overlay, not content
        if (target === modal.querySelector('.editmuse-concierge-modal-overlay')) {
          this.handleClose();
          return;
        }
      }, { signal });
      
      // Change handler for mobile selects
      modal.addEventListener('change', (e) => {
        if (e.target.matches('[data-em-select]')) {
          var value = e.target.value;
          if (value) {
            // Set answer using unified function
            this.setStepAnswer(this.state.current, value);
            
            // Update radio button and pill to match
            var stepEl = this.getStepEl(this.state.current);
            if (stepEl) {
              var allRadios = stepEl.querySelectorAll('input[type="radio"]');
              var allPills = stepEl.querySelectorAll('[data-em-option]');
              
              // Uncheck all radios and unselect all pills first
              for (var i = 0; i < allRadios.length; i++) {
                allRadios[i].checked = false;
              }
              for (var i = 0; i < allPills.length; i++) {
                allPills[i].classList.remove('selected', 'is-selected');
                allPills[i].setAttribute('aria-checked', 'false');
                allPills[i].setAttribute('aria-pressed', 'false');
              }
              
              // Find and select the matching option
              for (var i = 0; i < allPills.length; i++) {
                var pill = allPills[i];
                var pillValue = pill.getAttribute('data-value') || pill.dataset.value;
                if (pillValue === value) {
                  // Check corresponding radio
                  var radio = pill.querySelector('input[type="radio"]');
                  if (radio) {
                    radio.checked = true;
                  }
                  // Select the pill
                  pill.classList.add('selected', 'is-selected');
                  pill.setAttribute('aria-checked', 'true');
                  pill.setAttribute('aria-pressed', 'true');
                  break;
                }
              }
            }
            
            // Update navigation state
            this.updateNavState();
            
            if (window.EDITMUSE_DEBUG) {
              debugLog('[EditMuse] Select changed', { value: value, currentStep: this.state.current });
            }
          }
        }
      }, { signal });
      
      // Input handler for text inputs
      modal.addEventListener('input', (e) => {
        if (e.target.matches('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]')) {
          // Store answer as user types
          var value = e.target.value.trim();
          if (value) {
            this.setStepAnswer(this.state.current, value);
          } else {
            // Clear answer if empty
            delete this.state.answers[this.state.current];
            delete this.quizAnswers[this.state.current];
          }
          // Update navigation state
          this.updateNavState();
        }
      }, { signal });
    }

    setupEventDelegation() {
      // Create new AbortController for this instance
      this.abortController = new AbortController();
      var signal = this.abortController.signal;

      // Delegated click handler on the element itself
      this.addEventListener('click', (e) => {
        var target = e.target;
        
        // Start button
        if (target.matches('[data-editmuse-start]') || target.closest('[data-editmuse-start]')) {
          e.preventDefault();
          e.stopPropagation();
          debugLog('[EditMuse] Start button clicked', this.blockId);
          this.handleStart();
          return;
        }
      
        // Next/Submit button
        var nextBtn = target.closest('[data-editmuse-next]');
        if (nextBtn && !nextBtn.disabled && !nextBtn.hasAttribute('disabled')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleNext();
          return;
        }

        // Back button
        var backBtn = target.closest('[data-editmuse-back]');
        if (backBtn && !backBtn.disabled && !backBtn.hasAttribute('disabled')) {
          e.preventDefault();
          e.stopPropagation();
          this.handleBack();
        return;
      }
      
        // Option pill clicks - state-driven selection
        var pill = target.closest('[data-em-option]');
        if (pill) {
          e.preventDefault();
          e.stopPropagation();
          var value = pill.getAttribute('data-value') || pill.dataset.value;
          if (value) {
            // Update state immediately
            this.state.answers[this.state.current] = value;
            // Re-render to update selected state
            this.render();
            // Update navigation state
            this.updateNavState();
          }
        return;
      }
      
        // Close button
        if (target.matches('.editmuse-concierge-modal-close') || target.closest('.editmuse-concierge-modal-close')) {
                e.preventDefault();
          e.stopPropagation();
          this.handleClose();
          return;
        }

        // Overlay click (close modal) - check if click is on overlay, not content
        var modal = this.modalElement || this.querySelector('.editmuse-concierge-modal');
        if (modal && target === modal.querySelector('.editmuse-concierge-modal-overlay')) {
          this.handleClose();
          return;
        }
      }, { signal });

      // Delegated change handler for mobile selects - DEPRECATED: now handled in setupModalEventDelegation
      // Keeping for backward compatibility
      this.addEventListener('change', (e) => {
        if (e.target.matches('[data-em-select]')) {
          var value = e.target.value;
          if (value) {
            // Update state immediately
            this.setStepAnswer(this.state.current, value);
            // Re-render to update selected state
            this.render();
            // Update navigation state
            this.updateNavState();
          }
        }
      }, { signal });

      // Input handler for text inputs - also check in modal
      var inputHandler = function(e) {
        if (e.target.matches('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]')) {
          // Find which component owns this input
          var modal = e.target.closest('.editmuse-concierge-modal');
          if (modal) {
            var blockId = modal.getAttribute('data-block-id');
            if (blockId) {
              var components = document.querySelectorAll('editmuse-concierge');
              for (var i = 0; i < components.length; i++) {
                if (components[i].blockId === blockId) {
                  components[i].updateNavState();
                  break;
                }
              }
            }
          }
        }
      };
      document.addEventListener('input', inputHandler, { signal });
      
      // ESC key handler to close modal - global handler
      var escHandler = function(e) {
        if (e.key === 'Escape') {
          var root = getModalRoot();
          var openModal = root.querySelector('.editmuse-concierge-modal.show');
          if (openModal) {
            var blockId = openModal.getAttribute('data-block-id');
            if (blockId && modalRegistry[blockId]) {
              // Find the component instance that owns this modal
              var components = document.querySelectorAll('editmuse-concierge');
              for (var i = 0; i < components.length; i++) {
                if (components[i].blockId === blockId) {
              e.preventDefault();
                  e.stopPropagation();
                  components[i].handleClose();
                  break;
                }
              }
            }
          }
        }
      };
      document.addEventListener('keydown', escHandler, { signal });
    }

    // Get attributes
    getExperienceId() {
      // First check custom element attribute
      var experienceId = this.getAttribute('experience-id');
      if (experienceId && experienceId.trim() !== '') {
        return experienceId.trim();
      }
      
      // Fallback: check wrapper element data attribute
      var wrapperEl = this.getWrapperElement();
      if (wrapperEl) {
        experienceId = wrapperEl.getAttribute('data-experience-id');
        if (experienceId && experienceId.trim() !== '') {
          return experienceId.trim();
        }
      }
      
      return '';
    }

    getResultUrl() {
      return this.getAttribute('result-url') || '/pages/editmuse-results';
    }

    getResultCount() {
      var count = this.getAttribute('result-count');
      return count ? parseInt(count, 10) : undefined;
    }

    getStartMode() {
      return this.getAttribute('start-mode') || 'hybrid';
    }

    getChatPlaceholder() {
      return this.getAttribute('chat-placeholder') || null;
    }

    getButtonLabel() {
      return this.getAttribute('button-label') || 'Start Style Quiz';
    }

    // Fetch questions from API
    async fetchQuestions() {
      var experienceId = this.getExperienceId();
      debugLog('[EditMuse] Fetching questions', { 
        experienceId: experienceId, 
        hasExperienceId: !!experienceId && experienceId.trim() !== '',
        customElementAttr: this.getAttribute('experience-id'),
        wrapperAttr: this.getWrapperElement() ? this.getWrapperElement().getAttribute('data-experience-id') : null
      });
      
      var requestBody = {};
      
      // Use the experienceId we already retrieved above
      if (experienceId && experienceId.trim() !== '') {
        requestBody.experienceId = experienceId;
      } else {
        debugLog('[EditMuse] WARNING: No experience ID found. Request will use default experience.');
      }
      
      var resultCount = this.getResultCount();
      if (resultCount !== undefined && resultCount !== null) {
        requestBody.resultCount = resultCount;
      }

      try {
        var response = await fetch(proxyUrl('/session/start'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          var errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch questions');
        }

        var data = await response.json();
        debugLog('[EditMuse] Questions response:', data);

        if (data.ok && data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
          debugLog('[EditMuse] Successfully fetched', data.questions.length, 'questions');
          return data.questions;
        }

        var errorMsg = data.error || 'No questions available from experience';
        if (data.questions && Array.isArray(data.questions) && data.questions.length === 0) {
          errorMsg = 'Experience has no questions configured';
        }
        debugLog('[EditMuse] Failed to get questions:', errorMsg, data);
        throw new Error(errorMsg);
      } catch (error) {
        debugLog('[EditMuse] Error fetching questions:', error);
        // Re-throw with more context
        if (error.message) {
          throw error;
        } else {
          throw new Error('Failed to fetch questions: ' + (error.toString() || 'Unknown error'));
        }
      }
    }

    // Handle Start button click
    async handleStart() {
      if (this.state.loading) {
        debugLog('[EditMuse] handleStart: Already loading, skipping');
        return;
      }

      debugLog('[EditMuse] handleStart: Starting', this.blockId);

      // Close all modals before opening this one
      closeAllModals();

      this.state.loading = true;
      this.state.error = null;
      this.state.open = true;
      this.state.mode = this.getStartMode();
      this.state.current = 0;
      this.state.answers = [];
      // Initialize questions as empty array to prevent errors during render
      if (!this.state.questions) {
        this.state.questions = [];
      }
      
      // Chat question constants
      // Get custom placeholder from component attribute, or use default
      var customChatPlaceholder = this.getChatPlaceholder();
      var defaultChatPlaceholder = 'Tell us what you need';
      var EM_CHAT_QUESTION = {
        type: 'textarea',
        question: 'Start a chat',
        prompt: 'Start a chat',
        placeholder: customChatPlaceholder || defaultChatPlaceholder
      };
      
      var EM_HYBRID_CHAT_QUESTION = {
        type: 'textarea',
        question: 'Any extra details?',
        prompt: 'Any extra details?',
        placeholder: 'Optional: add details that will improve recommendations (brand tone, audience, length, style)…'
      };
      
      debugLog('[EditMuse] handleStart: Rendering initial state', { open: this.state.open, mode: this.state.mode });
      this.render();
      
      // Ensure modal is portaled and visible before showing
      // render() creates the modal and portals it, but we need to ensure it's ready
      setTimeout(() => {
        // Show modal immediately (even before questions are fetched) so user sees loading state
        this.showModal();
      }, 0);

      try {
        var mode = this.state.mode;
        
        if (mode === 'chat') {
          // Chat mode: single textarea step
          this.state.questions = [EM_CHAT_QUESTION];
          this.state.current = 0;
          this.state.answers = {};
          this.state.loading = false;
          this.state.error = null;
          this.render();
          this.updateNavState();
          this.updateProgressBar();
        } else if (mode === 'quiz') {
          // Quiz mode: fetch questions and use as-is
          var fetchPromise = this.fetchQuestions();
          var timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out after 30 seconds')), 30000)
          );
          this.state.questions = await Promise.race([fetchPromise, timeoutPromise]);
          this.state.current = 0;
        } else if (mode === 'hybrid') {
          // Hybrid mode: fetch questions then append chat question
          var fetchPromise = this.fetchQuestions();
          var timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out after 30 seconds')), 30000)
          );
          var fetchedQuestions = await Promise.race([fetchPromise, timeoutPromise]);
          this.state.questions = fetchedQuestions.concat([EM_HYBRID_CHAT_QUESTION]);
          this.state.current = 0;
        }
      } catch (error) {
        this.state.error = error.message || 'Failed to load questions. Please try again.';
        debugLog('[EditMuse] Error in handleStart:', error);
        console.error('[EditMuse] Error loading questions:', error);
      } finally {
        this.state.loading = false;
        debugLog('[EditMuse] handleStart: Rendering final state', { 
          open: this.state.open, 
          questionsCount: this.state.questions ? this.state.questions.length : 0,
          modalElement: !!this.modalElement,
          error: this.state.error
        });
        this.render();
        // Show modal after render - use setTimeout to ensure DOM is updated
        setTimeout(() => {
          debugLog('[EditMuse] handleStart: Showing modal', { modalElement: !!this.modalElement });
          this.showModal();
        }, 0);
      }
    }
    
    // Show modal
    showModal() {
      // Find modal if not already set (might be in portal)
      if (!this.modalElement) {
        var wrapperEl = this.getWrapperElement();
        var blockId = this.blockId || (wrapperEl && (wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id')));
        if (blockId) {
          // Try to find modal in portal
          this.modalElement = document.body.querySelector('[data-em-portal-for="' + blockId + '"]');
        }
        // Fallback: find in custom element
        if (!this.modalElement) {
          this.modalElement = this.querySelector('.editmuse-concierge-modal');
        }
      }
      
      if (this.modalElement) {
        // Move modal to body if not already there (for z-index safety)
        if (!this.modalElement.isConnectedToBody) {
          if (this.modalElement.parentNode !== document.body) {
            document.body.appendChild(this.modalElement);
          }
          this.modalElement.isConnectedToBody = true;
        }
        
        // Copy root data attributes to modal for CSS targeting
        var wrapperEl = this.getWrapperElement();
        if (wrapperEl) {
          var rootAttrs = ['em-brand', 'em-modal-style', 'em-option-style', 'em-sticky-nav', 
                          'em-show-progress', 'em-show-close', 'em-use-gradient', 'em-motion'];
          for (var i = 0; i < rootAttrs.length; i++) {
            var attrName = 'data-' + rootAttrs[i];
            var attrValue = wrapperEl.getAttribute(attrName);
            if (attrValue !== null) {
              this.modalElement.setAttribute(attrName, attrValue);
            }
          }
        }
        
        // Re-apply preset system before showing (in case settings changed in Theme Editor)
        if (wrapperEl) {
          // Use data-editmuse-block-id for Theme Editor compatibility
          var blockId = wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id') || 'unknown';
          this.applyPresetToModal(this.modalElement, wrapperEl, blockId);
        }
        
        // Use class-based visibility
        this.modalElement.classList.add('show');
        this.modalElement.hidden = false;
        setModalAriaHidden(this.modalElement, false);
        // Lock body scroll
        document.body.style.overflow = 'hidden';
        document.documentElement.classList.add('editmuse-modal-open');
        
        // Re-apply accent colors on live modal node after DOM update
        if (wrapperEl) {
          requestAnimationFrame(() => {
            const liveModal = document.querySelector('.editmuse-concierge-modal.show');
            if (liveModal) ensureAccentsFromRoot(wrapperEl, liveModal);
            
            // Extra safety: apply again next frame in case of transitions/rehydration
            requestAnimationFrame(() => {
              const liveModal2 = document.querySelector('.editmuse-concierge-modal.show');
              if (liveModal2) ensureAccentsFromRoot(wrapperEl, liveModal2);
            });
          });
        }
        
        debugLog('[EditMuse] Modal shown', this.blockId);
      } else {
        debugLog('[EditMuse] ERROR: Modal element not found when trying to show', this.blockId);
        // Try to find modal one more time and show it
        var wrapperEl = this.getWrapperElement();
        var blockId = this.blockId || (wrapperEl && (wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id')));
        if (blockId) {
          var modal = document.body.querySelector('[data-em-portal-for="' + blockId + '"]');
          if (modal) {
            this.modalElement = modal;
            if (modal.parentNode !== document.body) {
              document.body.appendChild(modal);
            }
            modal.isConnectedToBody = true;
            modal.classList.add('show');
            modal.hidden = false;
            setModalAriaHidden(modal, false);
            document.body.style.overflow = 'hidden';
            document.documentElement.classList.add('editmuse-modal-open');
            
            // Re-apply accent colors on live modal node after DOM update
            if (wrapperEl) {
              requestAnimationFrame(() => {
                const liveModal = document.querySelector('.editmuse-concierge-modal.show');
                if (liveModal) ensureAccentsFromRoot(wrapperEl, liveModal);
                
                // Extra safety: apply again next frame in case of transitions/rehydration
                requestAnimationFrame(() => {
                  const liveModal2 = document.querySelector('.editmuse-concierge-modal.show');
                  if (liveModal2) ensureAccentsFromRoot(wrapperEl, liveModal2);
                });
              });
            }
            
            debugLog('[EditMuse] Modal found and shown on retry', blockId);
          } else {
            // Last resort: trigger render to create modal
            debugLog('[EditMuse] Triggering render to create modal', blockId);
            this.render();
            // Try again after render
            setTimeout(() => {
              this.showModal();
            }, 100);
          }
        }
      }
    }
    
    // Hide modal
    hideModal() {
      if (this.modalElement) {
        this.modalElement.classList.remove('show');
        this.modalElement.hidden = true;
        setModalAriaHidden(this.modalElement, true);
      }
      // Unlock scroll if no modals are open
      var openModals = document.body.querySelectorAll('.editmuse-concierge-modal.show');
      if (openModals.length === 0) {
        document.body.style.overflow = '';
        document.documentElement.classList.remove('editmuse-modal-open');
      }
    }

    // Handle Next button click (unified for text + select)
    handleNext(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (this.state.loading) return;

      var currentStepEl = this.getStepEl(this.state.current);
      if (!currentStepEl) return;

      // Get answer using unified function
      var answer = this.getStepAnswer(currentStepEl);
      
      // For text questions, sync from DOM to state if not already set
      var question = this.state.questions[this.state.current];
      if (question && question.type === 'text' && !answer) {
        var textInput = currentStepEl.querySelector('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]');
        if (textInput && textInput.value.trim() !== '') {
          answer = textInput.value.trim();
          this.setStepAnswer(this.state.current, answer);
        }
      }

      // Validate using unified function
      if (!this.validateStep(currentStepEl)) {
        this.showError('Please fill in this field');
        return;
      }
      
      // Store answer if not already stored
      if (answer && !this.state.answers[this.state.current]) {
        this.setStepAnswer(this.state.current, answer);
      }
        
      // Clear error on valid input
      this.hideError();

      if (window.EDITMUSE_DEBUG) {
        debugLog('[EditMuse] Next handler', {
          currentStep: this.state.current,
          totalSteps: this.state.questions.length,
          type: question ? question.type : 'unknown',
          answer: answer,
          valid: true
        });
      }

      // Check if last step
      if (this.state.current === this.state.questions.length - 1) {
        // Submit
        this.handleSubmit();
      } else {
        // Advance to next step
        this.state.current++;
        this.state.error = null;
        this.render();
        // Update navigation state after render
        setTimeout(() => {
          this.updateNavState();
          this.updateProgressBar();
        }, 0);
      }
    }

    // Handle Back button click (unified for text + select)
    handleBack(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (this.state.current > 0) {
        var currentStepEl = this.getStepEl(this.state.current);
        
        // Store current answer before going back (unified for text + select)
        if (currentStepEl) {
          var answer = this.getStepAnswer(currentStepEl);
          if (answer) {
            this.setStepAnswer(this.state.current, answer);
          }
        }
        
        // Go back one step
        this.state.current--;
        this.state.error = null;
        this.hideError();
        this.render();
        
        // Restore answer for the previous step
        var prevStepEl = this.getStepEl(this.state.current);
        if (prevStepEl) {
          var prevAnswer = this.state.answers[this.state.current];
          if (prevAnswer) {
            this.restoreAnswer(this.state.questions[this.state.current], prevAnswer);
          }
        }
        
        // Update navigation state
        setTimeout(() => {
          this.updateNavState();
          this.updateProgressBar();
        }, 0);
      }
    }

    // Handle option selection - DEPRECATED: now handled directly in event delegation
    // Keeping for backwards compatibility but not used
    handleOptionSelect(value) {
      this.setStepAnswer(this.state.current, value);
      this.updateNavState();
      this.render();
    }

    // Handle Submit (unified for text + select)
    async handleSubmit(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      
      // Check global submit lock before checking local loading state
      if (window.__EDITMUSE_SUBMIT_LOCK.inFlight) {
        debugLog('[EditMuse] Submit blocked - already in flight', window.__EDITMUSE_SUBMIT_LOCK);
        return;
      }
      
      if (this.state.loading) return;

      debugLog('[EditMuse] handleSubmit fired', { 
        currentStep: this.state.current, 
        totalSteps: this.state.questions.length 
      });
      
      // Generate request ID and set lock
      const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
      window.__EDITMUSE_SUBMIT_LOCK.inFlight = true;
      window.__EDITMUSE_SUBMIT_LOCK.requestId = rid;
      window.__EDITMUSE_SUBMIT_LOCK.startedAt = Date.now();

      var currentStepEl = this.getStepEl(this.state.current);
      if (!currentStepEl) {
        window.__EDITMUSE_SUBMIT_LOCK.inFlight = false;
        window.__EDITMUSE_SUBMIT_LOCK.requestId = null;
        return;
      }

      // Get answer using unified function
      var finalAnswer = this.getStepAnswer(currentStepEl);
      
      // For text questions, sync from DOM to state if not already set
      var question = this.state.questions[this.state.current];
      if (question && question.type === 'text' && !finalAnswer) {
        var textInput = currentStepEl.querySelector('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]');
        if (textInput && textInput.value.trim() !== '') {
          finalAnswer = textInput.value.trim();
          this.setStepAnswer(this.state.current, finalAnswer);
        }
      }

      // Validate using unified function
      if (!this.validateStep(currentStepEl)) {
        window.__EDITMUSE_SUBMIT_LOCK.inFlight = false;
        window.__EDITMUSE_SUBMIT_LOCK.requestId = null;
        this.showError('Please fill in this field');
        return;
      }
      
      // Store answer if not already stored
      if (finalAnswer && !this.state.answers[this.state.current]) {
        this.setStepAnswer(this.state.current, finalAnswer);
      }

      // Clear error on valid input
      this.hideError();

      debugLog('[EditMuse] Submit handler - current:', this.state.current, 'type:', question ? question.type : 'unknown', 'answer:', finalAnswer, 'valid:', !!finalAnswer);

      // Collect all answers from state (never read DOM for select)
      var messages = [];
      for (var i = 0; i < this.state.questions.length; i++) {
        var answer = this.state.answers[i];
        if (answer !== undefined && answer !== null && answer !== '') {
          messages.push(answer);
        }
      }

      if (messages.length === 0) {
        window.__EDITMUSE_SUBMIT_LOCK.inFlight = false;
        window.__EDITMUSE_SUBMIT_LOCK.requestId = null;
        this.showError('Please answer at least one question');
        return;
      }
      
      // Clear any errors before submitting
      this.hideError();

      this.state.loading = true;
      this.render();

      try {
          var requestBody = {
            answers: messages,
            clientRequestId: window.__EDITMUSE_SUBMIT_LOCK.requestId
          };

        var experienceId = this.getExperienceId();
          if (experienceId && experienceId.trim() !== '') {
            requestBody.experienceId = experienceId;
          }

        var resultCount = this.getResultCount();
          if (resultCount !== undefined && resultCount !== null) {
            requestBody.resultCount = resultCount;
          }
          
        debugLog('Submitting answers:', messages);
        debugLog('[EditMuse] Submitting with clientRequestId', window.__EDITMUSE_SUBMIT_LOCK);

        var response = await fetch(proxyUrl('/session/start'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          var errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to submit');
        }

        var data = await response.json();
        debugLog('Submit response:', data);

            if (data.ok && data.sessionId) {
          this.state.sessionId = data.sessionId;
              sessionStorage.setItem('editmuse_sid', data.sessionId);

          // Release lock before redirect
          window.__EDITMUSE_SUBMIT_LOCK.inFlight = false;
          window.__EDITMUSE_SUBMIT_LOCK.requestId = null;

          // Redirect
          var redirectUrl = this.getResultUrl();
              var u = new URL(redirectUrl, window.location.origin);
              u.searchParams.set('sid', data.sessionId);
              
          // Preserve Shopify params
              var cur = new URL(window.location.href);
                var shop = cur.searchParams.get('shop');
                var signature = cur.searchParams.get('signature');
                var timestamp = cur.searchParams.get('timestamp');
                if (shop) u.searchParams.set('shop', shop);
                if (signature) u.searchParams.set('signature', signature);
                if (timestamp) u.searchParams.set('timestamp', timestamp);
                
              var previewThemeId = cur.searchParams.get('preview_theme_id');
              if (previewThemeId) {
                u.searchParams.set('preview_theme_id', previewThemeId);
              }
              
          window.location.href = u.pathname + u.search;
            } else {
              throw new Error(data.error || 'Invalid response from server');
            }
        } catch (error) {
        // Release lock on error
        window.__EDITMUSE_SUBMIT_LOCK.inFlight = false;
        window.__EDITMUSE_SUBMIT_LOCK.requestId = null;
        
        this.state.error = error.message;
        this.state.loading = false;
        this.render();
        debugLog('Error in handleSubmit:', error);
      }
    }

    // Handle Close
    handleClose() {
      this.state.open = false;
      this.state.error = null;
      this.hideModal();
      this.render();
    }

    // Get current answer - state-driven for select, DOM for text
    getCurrentAnswer() {
      if (this.state.current < 0 || this.state.current >= this.state.questions.length) {
        return null;
      }

      var question = this.state.questions[this.state.current];
      if (!question) return null;

      // For select questions, always use state (never query DOM)
      if (question.type === 'select') {
        return this.state.answers[this.state.current] || null;
      }

      // For text questions, check state first, then fall back to DOM
      if (this.state.answers[this.state.current] !== undefined) {
        return this.state.answers[this.state.current];
      }

      // Fallback: read from text input DOM (in modal)
      var textInput = this.modalElement ? this.modalElement.querySelector('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]') : null;
      if (textInput && textInput.value.trim() !== '') {
        return textInput.value.trim();
      }

      return null;
    }

    // Validate current step and enable/disable Next button - DEPRECATED: use updateNavState() instead
    // Keeping for backward compatibility
    validateCurrentStep() {
      this.updateNavState();
    }

    // Show error message - update existing error element, don't create new ones
    showError(message) {
      this.state.error = message;
      // Update existing error element if modal is open
      if (this.modalElement) {
        var errorEl = this.modalElement.querySelector('.editmuse-concierge-error');
        if (errorEl) {
          errorEl.textContent = message;
          errorEl.style.display = 'block';
          } else {
          // If error element doesn't exist, render to create it
          this.render();
        }
      } else {
        this.render();
      }
    }
    
    // Hide error message
    hideError() {
      this.state.error = null;
      if (this.modalElement) {
        var errorEl = this.modalElement.querySelector('.editmuse-concierge-error');
        if (errorEl) {
          errorEl.style.display = 'none';
          errorEl.textContent = '';
        }
      }
    }

    // Render UI from state
    render() {
      // Preserve powered-by element if it exists
      var poweredBy = this.querySelector('.editmuse-powered-by');
      var poweredByHTML = poweredBy ? poweredBy.outerHTML : '';

      // Read button settings from root wrapper (Theme Editor settings)
      var wrapperEl = this.getWrapperElement();
      var btnVariant = wrapperEl ? (wrapperEl.getAttribute('data-btn-variant') || 'solid') : 'solid';
      var btnSize = wrapperEl ? (wrapperEl.getAttribute('data-btn-size') || 'md') : 'md';
      var btnFullWidth = wrapperEl ? (wrapperEl.getAttribute('data-btn-full-width') === 'true') : false;
      
      // Build button classes - CSS uses wrapper style attributes, so we just need base class
      var buttonClasses = 'editmuse-concierge-button';
      if (btnFullWidth) {
        buttonClasses += ' em-btn--full';
      }

      // Render button (if not open)
      if (!this.state.open) {
        this.innerHTML = `
          <div class="editmuse-concierge-block">
            <button type="button" class="${buttonClasses}" data-editmuse-start>
              ${this.escapeHtml(this.getButtonLabel())}
            </button>
            ${poweredByHTML}
          </div>
        `;
        return;
      }

      // Render modal
      // Ensure questions is an array
      var questions = this.state.questions || [];
      var currentQuestion = questions[this.state.current] || null;
      var isLastStep = this.state.current === questions.length - 1;
      var totalSteps = questions.length;
      var progress = totalSteps > 0 ? ((this.state.current + 1) / totalSteps) * 100 : 0;
      var currentAnswer = this.state.answers[this.state.current] || '';

      var questionHTML = '';
      if (currentQuestion) {
        if (currentQuestion.type === 'select') {
          questionHTML = this.renderSelectQuestion(currentQuestion, currentAnswer);
        } else {
          questionHTML = this.renderTextQuestion(currentQuestion, currentAnswer);
        }
      }

      var nextButtonText = isLastStep ? 'Submit' : 'Next';
      var backButtonDisplay = this.state.current > 0 ? 'inline-block' : 'none';
      var backButtonDisabled = this.state.current === 0;

      var errorHTML = this.state.error ? `<div class="editmuse-concierge-error" style="display: block;">${this.escapeHtml(this.state.error)}</div>` : '';

      // Render button container (always visible)
      var buttonContainer = this.querySelector('.editmuse-concierge-block');
      if (!buttonContainer) {
        buttonContainer = document.createElement('div');
        buttonContainer.className = 'editmuse-concierge-block';
        this.appendChild(buttonContainer);
      }
      buttonContainer.innerHTML = `
        <button type="button" class="${buttonClasses}" data-editmuse-start ${this.state.open ? 'style="display: none;"' : ''}>
          ${this.escapeHtml(this.getButtonLabel())}
        </button>
        ${poweredByHTML}
      `;

      // Render or update modal (only if open)
      if (this.state.open) {
        // Try to find existing modal (might be in portal or in custom element)
        var modal = this.modalElement || this.querySelector('.editmuse-concierge-modal') || document.body.querySelector('[data-em-portal-for="' + this.blockId + '"]');
        if (!modal) {
          // Create modal if it doesn't exist
          modal = document.createElement('div');
          modal.className = 'editmuse-concierge-modal';
          var modalStyle = this.getAttribute('data-modal-style') || 'bottom_sheet';
          modal.setAttribute('data-modal-style', modalStyle);
          this.appendChild(modal);
        }
        
        // Ensure modalElement is set
        this.modalElement = modal;
        
        // Get modal style from attribute
        var modalStyle = this.getAttribute('data-modal-style') || 'bottom_sheet';
        modal.setAttribute('data-modal-style', modalStyle);
        
        // Get badge text and settings from wrapper
        var wrapperEl = this.getWrapperElement();
        var badgeText = wrapperEl ? wrapperEl.getAttribute('data-em-header-badge') : null;
        // Only use fallback if badgeText is null/undefined (not set), not if it's empty string (blank)
        if (badgeText === null || badgeText === undefined) {
          badgeText = this.getAttribute('data-v2-header-badge') || '';
        }
        // If badgeText is empty string, convert to null so it doesn't render
        if (badgeText === '') {
          badgeText = null;
        }
        var showClose = wrapperEl ? (wrapperEl.getAttribute('data-em-show-close') !== 'false') : (this.getAttribute('data-v2-show-close') !== 'false');
        // Read showProgress from wrapper - convert string to boolean
        var showProgressAttr = wrapperEl ? wrapperEl.getAttribute('data-em-show-progress') : null;
        var showProgress = showProgressAttr !== 'false'; // Default to true if not set or if 'true'
        // Force hide progress bar for chat mode
        if (this.state.mode === 'chat') {
          showProgress = false;
        }
        
        modal.innerHTML = `
          <div class="editmuse-concierge-modal-overlay"></div>
          <div class="editmuse-concierge-modal-content editmuse-concierge-wrapper">
            <div class="em-modal-header">
              <div class="em-modal-header-row">
                <div class="em-modal-title">Tell us what you need</div>
                ${showClose ? '<button type="button" class="editmuse-concierge-modal-close" aria-label="Close">&times;</button>' : ''}
              </div>
              ${badgeText ? `<div class="em-modal-badge">${this.escapeHtml(badgeText)}</div>` : ''}
            </div>
            <div class="em-progress" data-em-progress aria-hidden="${showProgress ? 'false' : 'true'}" ${showProgress ? '' : 'style="display: none;"'}><div class="em-progress-bar"></div></div>
            <div class="em-modal-body">
              <div class="em-modal-content-area">
                ${this.state.loading ? '<div style="text-align: center; padding: 2rem;">Loading...</div>' : questionHTML}
                <div class="editmuse-concierge-error" style="display: ${this.state.error ? 'block' : 'none'};">${this.state.error ? this.escapeHtml(this.state.error) : ''}</div>
              </div>
              <div class="editmuse-concierge-navigation">
                <button type="button" class="editmuse-concierge-nav-btn editmuse-concierge-back" data-editmuse-back style="display: ${backButtonDisplay};" ${backButtonDisabled ? 'disabled' : ''}>
                  Back
                </button>
                <button type="button" class="editmuse-concierge-nav-btn editmuse-concierge-next" data-editmuse-next ${this.state.loading ? 'disabled' : ''}>
                  ${this.state.loading ? 'Loading...' : nextButtonText}
                </button>
              </div>
            </div>
          </div>
        `;

        // Brand-style sync: ensure wrapper gets attributes even if applyConfigToModal ran earlier
        const brand =
          modal.getAttribute('data-v2-brand-style') ||
          modal.getAttribute('data-em-brand-style') ||
          modal.dataset.brandStyle ||
          'pop';
        const wrap = modal.querySelector('.editmuse-concierge-modal-content');
        if (wrap) {
          wrap.setAttribute('data-v2-brand-style', brand);
          wrap.setAttribute('data-em-brand-style', brand);
        }

        // Ensure modalElement is set before portaling
        this.modalElement = modal;
        
        // Move modal to portal (this will copy theme vars and classes)
        this.moveModalToPortal();
        
        // Ensure modalElement is still set after portaling (in case it was moved)
        // After portaling, modal might be in document.body, so find it again
        if (!this.modalElement || this.modalElement.parentNode !== document.body) {
          var wrapperEl = this.getWrapperElement();
          var blockId = this.blockId || (wrapperEl && (wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id')));
          if (blockId) {
            this.modalElement = document.body.querySelector('[data-em-portal-for="' + blockId + '"]');
          }
          // Final fallback
          if (!this.modalElement) {
            this.modalElement = modal;
          }
        }
        
        // If modal was just created and we're opening, ensure it's visible
        if (this.state.open && this.modalElement) {
          // Move to body if not already there
          if (!this.modalElement.isConnectedToBody) {
            if (this.modalElement.parentNode !== document.body) {
              document.body.appendChild(this.modalElement);
            }
            this.modalElement.isConnectedToBody = true;
          }
          
          // Copy root data attributes to modal for CSS targeting
          var wrapperEl = this.getWrapperElement();
          if (wrapperEl) {
            var rootAttrs = ['em-brand', 'em-modal-style', 'em-option-style', 'em-sticky-nav', 
                            'em-show-progress', 'em-show-close', 'em-use-gradient', 'em-motion'];
            for (var i = 0; i < rootAttrs.length; i++) {
              var attrName = 'data-' + rootAttrs[i];
              var attrValue = wrapperEl.getAttribute(attrName);
              if (attrValue !== null) {
                this.modalElement.setAttribute(attrName, attrValue);
              }
            }
          }
          
          this.modalElement.classList.add('show');
          this.modalElement.hidden = false;
          setModalAriaHidden(this.modalElement, false);
          // Lock body scroll
          document.body.style.overflow = 'hidden';
          document.documentElement.classList.add('editmuse-modal-open');
          
          // Re-apply accent colors on live modal node after DOM update
          if (wrapperEl) {
            requestAnimationFrame(() => {
              const liveModal = document.querySelector('.editmuse-concierge-modal.show');
              if (liveModal) ensureAccentsFromRoot(wrapperEl, liveModal);
              
              // Extra safety: apply again next frame in case of transitions/rehydration
              requestAnimationFrame(() => {
                const liveModal2 = document.querySelector('.editmuse-concierge-modal.show');
                if (liveModal2) ensureAccentsFromRoot(wrapperEl, liveModal2);
              });
            });
          }
          
          if (window.EDITMUSE_DEBUG) {
            debugLog('[EditMuse] Modal made visible in render', { blockId: this.blockId, modalElement: !!this.modalElement });
          }
        }
        
        // Re-bind handlers if modal was recreated
        if (!modal.dataset.editmuseHandlersBound) {
          this.setupModalEventDelegation(modal);
          modal.dataset.editmuseHandlersBound = 'true';
        }
        
        // Re-apply preset system (in case modal was already in portal or re-rendered)
        var wrapperEl = this.getWrapperElement();
        if (wrapperEl) {
          // Use data-editmuse-block-id for Theme Editor compatibility
          var blockId = wrapperEl.getAttribute('data-editmuse-block-id') || wrapperEl.getAttribute('data-block-id') || wrapperEl.getAttribute('data-em-block-id') || 'unknown';
          this.applyPresetToModal(modal, wrapperEl, blockId);
        }
        
        // Update progress fill using CSS custom property (0..1)
        var progressValue = totalSteps > 0 ? (this.state.current + 1) / totalSteps : 0;
        modal.style.setProperty('--em-progress', String(progressValue));
        
        // Update progress bar element if it exists
        var progressBar = modal.querySelector('[data-editmuse-progress-bar]');
        if (progressBar) {
          var progressPercent = totalSteps > 0 ? ((this.state.current + 1) / totalSteps) * 100 : 0;
          progressBar.style.width = progressPercent + '%';
        }
        
        // Also update em-progress-bar if it exists (legacy)
        var legacyProgressBar = modal.querySelector('.em-progress-bar');
        if (legacyProgressBar) {
          var progressPercent = totalSteps > 0 ? ((this.state.current + 1) / totalSteps) * 100 : 0;
          legacyProgressBar.style.width = progressPercent + '%';
        }

        // Restore answer if exists
        if (currentQuestion && currentAnswer) {
          this.restoreAnswer(currentQuestion, currentAnswer);
        }

        // Update navigation state after render
        setTimeout(() => {
          this.updateNavState();
          this.updateProgressBar();
        }, 0);
        } else {
        // Hide modal if not open
        this.hideModal();
      }
    }

    // Render select question
    renderSelectQuestion(question, selectedValue) {
      var questionText = question.question || question.prompt || 'Question';
      var options = question.options || [];
      var optionLayout = this.getAttribute('data-option-layout') || 'stacked';
      var optionStyle = this.getAttribute('data-option-style') || 'cards';
      var pillsClass = optionLayout === 'grid2' ? 'editmuse-option-pills editmuse-option-pills-grid2' : 'editmuse-option-pills';

      var pillsHTML = options.map((opt, idx) => {
        var optValue = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
        var optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
        var isSelected = selectedValue === optValue;
        var selectedClass = isSelected ? 'selected is-selected' : '';
        
        return `
          <button type="button" class="editmuse-option-pill ${selectedClass}" data-em-option="true" data-value="${this.escapeHtml(optValue)}" tabindex="0" role="radio" aria-checked="${isSelected}" aria-pressed="${isSelected}">
            <input type="radio" name="editmuse-q-${this.state.current}" id="editmuse-opt-${this.state.current}-${idx}" value="${this.escapeHtml(optValue)}" ${isSelected ? 'checked' : ''} style="display: none;">
            <span class="editmuse-option-pill-label">${this.escapeHtml(optLabel)}</span>
          </button>
        `;
      }).join('');

      var selectHTML = `
        <select class="editmuse-concierge-input editmuse-option-select-mobile" data-em-select="true">
          <option value="">Select an option...</option>
          ${options.map(opt => {
            var optValue = typeof opt === 'string' ? opt : (opt.value || opt.label || '');
            var optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
            var selected = selectedValue === optValue ? 'selected' : '';
            return `<option value="${this.escapeHtml(optValue)}" ${selected}>${this.escapeHtml(optLabel)}</option>`;
          }).join('')}
        </select>
      `;

      return `
        <div class="editmuse-concierge-step" data-step="${this.state.current}">
          <h2 class="editmuse-concierge-step-title">${this.escapeHtml(questionText)}</h2>
          <div class="editmuse-concierge-input-wrapper">
            <div class="${pillsClass}" data-editmuse-pills="${this.state.current}">
              ${pillsHTML}
            </div>
            ${selectHTML}
          </div>
        </div>
      `;
    }

    // Render text question
    renderTextQuestion(question, currentValue) {
      var questionText = question.question || question.prompt || 'Question';
      var placeholder = question.placeholder || '';
      var inputType = question.type === 'textarea' ? 'textarea' : 'input';

      // Show placeholder in input/textarea placeholder attribute (not in helper div to avoid duplication)
      var inputHTML = inputType === 'textarea' 
        ? `<textarea class="editmuse-concierge-input" data-editmuse-quiz-input="true" placeholder="${this.escapeHtml(placeholder)}">${this.escapeHtml(currentValue)}</textarea>`
        : `<input type="text" class="editmuse-concierge-input" data-editmuse-quiz-input="true" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(currentValue)}">`;

      return `
        <div class="editmuse-concierge-step" data-step="${this.state.current}">
          <h2 class="editmuse-concierge-step-title">${this.escapeHtml(questionText)}</h2>
          <div class="editmuse-concierge-input-wrapper">
            ${inputHTML}
          </div>
        </div>
      `;
    }

    // Restore answer to rendered input (unified for text + select)
    restoreAnswer(question, answer) {
      if (!question || !answer) return;
      
      var stepEl = this.getStepEl(this.state.current);
      if (!stepEl) return;
      
      if (question.type === 'select') {
        // Restore mobile select
        var select = stepEl.querySelector('[data-em-select]');
        if (select) {
          select.value = answer;
        }
        
        // Restore radio button and pill selected state
        var allRadios = stepEl.querySelectorAll('input[type="radio"]');
        var allPills = stepEl.querySelectorAll('[data-em-option]');
        
        // Uncheck all radios and unselect all pills first
        for (var i = 0; i < allRadios.length; i++) {
          allRadios[i].checked = false;
        }
        for (var i = 0; i < allPills.length; i++) {
          allPills[i].classList.remove('selected', 'is-selected');
          allPills[i].setAttribute('aria-checked', 'false');
          allPills[i].setAttribute('aria-pressed', 'false');
        }
        
        // Find and select the matching option
        for (var i = 0; i < allPills.length; i++) {
          var pill = allPills[i];
          var pillValue = pill.getAttribute('data-value') || pill.dataset.value;
          if (pillValue === answer) {
            // Check corresponding radio
            var radio = pill.querySelector('input[type="radio"]');
            if (radio) {
              radio.checked = true;
            }
            // Select the pill
            pill.classList.add('selected', 'is-selected');
            pill.setAttribute('aria-checked', 'true');
            pill.setAttribute('aria-pressed', 'true');
            break;
          }
        }
      } else {
        // Text input - restore value
        var input = stepEl.querySelector('input[type="text"][data-editmuse-quiz-input], textarea[data-editmuse-quiz-input]');
        if (input) {
          input.value = answer;
        }
      }
    }

    // Escape HTML
    escapeHtml(text) {
      var div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  });
      console.log('[EditMuse] Web component registration successful');
    }
  } catch (error) {
    console.error('[EditMuse] Failed to register web component:', error);
    console.error('[EditMuse] Error stack:', error.stack);
  }

  debugLog('EditMuse Concierge Web Component registered');
  
  // Theme Editor event handlers
  function handleSectionLoad() {
    debugLog('[EditMuse] Theme Editor: section load');
    setTimeout(function() {
      initAllBlocks();
      reapplyConfigToOpenModals();
    }, 50);
  }
  
  function handleBlockSelect(e) {
    debugLog('[EditMuse] Theme Editor: block select', e);
    setTimeout(function() {
      initAllBlocks();
      // Re-apply config to any open modals
      reapplyConfigToOpenModals();
    }, 50);
  }
  
  function handleBlockDeselect() {
    debugLog('[EditMuse] Theme Editor: block deselect');
    // No action needed on deselect
  }
  
  function handleSectionUnload(e) {
    debugLog('[EditMuse] Theme Editor: section unload', e);
    // Destroy instances for blocks in the unloaded section
    if (e.detail && e.detail.sectionId) {
      var section = document.querySelector('[data-section-id="' + e.detail.sectionId + '"]');
      if (section) {
        var blocks = section.querySelectorAll('[data-editmuse-concierge]');
        for (var i = 0; i < blocks.length; i++) {
          var blockId = blocks[i].getAttribute('data-editmuse-block-id') || blocks[i].getAttribute('data-block-id') || blocks[i].getAttribute('data-em-block-id');
      if (blockId) {
            if (conciergeInstances.has(blockId)) {
              var instance = conciergeInstances.get(blockId);
              if (instance && typeof instance.destroy === 'function') {
                instance.destroy();
              }
              conciergeInstances.delete(blockId);
            }
            if (window.__EDITMUSE_BLOCKS && window.__EDITMUSE_BLOCKS.has(blockId)) {
              window.__EDITMUSE_BLOCKS.delete(blockId);
            }
          }
        }
      }
    }
    // Re-init remaining blocks
    setTimeout(initAllBlocks, 50);
  }
  
  // Listen for Shopify theme editor events
  if (typeof document !== 'undefined') {
    // Wrap initialization in DOMContentLoaded
    document.addEventListener("DOMContentLoaded", function() {
      initAllBlocks();
    });
    
    // Theme Editor events
    if (window.Shopify && window.Shopify.designMode) {
      document.addEventListener('shopify:section:load', handleSectionLoad);
      document.addEventListener('shopify:block:select', handleBlockSelect);
      document.addEventListener('shopify:block:deselect', handleBlockDeselect);
      document.addEventListener('shopify:section:unload', handleSectionUnload);
    }
  }
})();
