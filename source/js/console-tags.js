(() => {
  'use strict';

  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)');

  const init = () => {
    const cloud = document.querySelector('#console .console-tag-cloud');
    if (!cloud || cloud.dataset.ready === '1') return;
    cloud.dataset.ready = '1';

    const items = Array.from(cloud.querySelectorAll('.console-tag-item'));
    if (!items.length) return;

    let baseRects = null;
    let current = -1;

    const setSpot = (index) => {
      if (index === current) return;
      current = index;
      const active = index >= 0 && baseRects ? baseRects[index] : null;

      items.forEach((el, i) => {
        let push = 0;
        let scale = 1;

        if (active && i === index) {
          scale = 1.12;
        } else if (active) {
          const rect = baseRects[i];
          const overlap = Math.min(rect.bottom, active.bottom) - Math.max(rect.top, active.top);
          if (overlap > 0) {
            const center = rect.left + rect.width / 2;
            const activeCenter = active.left + active.width / 2;
            const distance = Math.abs(center - activeCenter);
            if (distance > 0 && distance < 200) {
              push = Math.sign(center - activeCenter) * (1 - distance / 200) * 7;
            }
          }
        }

        el.style.setProperty('--push-x', `${push.toFixed(1)}px`);
        el.style.setProperty('--scale', scale.toFixed(2));
        el.classList.toggle('is-spot', i === index);
      });

      cloud.classList.toggle('is-spotlight', index >= 0);
    };

    if (!REDUCE.matches) {
      cloud.addEventListener('pointerenter', () => {
        baseRects = items.map((el) => el.getBoundingClientRect());
        setSpot(-1);
      });

      cloud.addEventListener('pointermove', (event) => {
        if (!baseRects) return;
        let hit = -1;
        for (let i = 0; i < baseRects.length; i += 1) {
          const rect = baseRects[i];
          if (
            event.clientX >= rect.left - 3 &&
            event.clientX <= rect.right + 3 &&
            event.clientY >= rect.top - 2 &&
            event.clientY <= rect.bottom + 2
          ) {
            hit = i;
            break;
          }
        }
        setSpot(hit);
      });

      cloud.addEventListener('pointerleave', () => {
        baseRects = null;
        setSpot(-1);
      });
    }

    cloud.addEventListener('click', (event) => {
      const link = event.target.closest('.console-tag-item');
      if (!link) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;

      event.preventDefault();
      if (link.classList.contains('is-launch')) return;

      setSpot(-1);

      const go = () => {
        window.location.href = link.href;
      };
      if (REDUCE.matches) {
        go();
        return;
      }

      link.classList.add('is-launch');
      window.setTimeout(go, 230);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
