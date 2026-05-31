/* 마우스 위치 — 카드·메뉴 항목별 개별 플로팅 (완만한 강도) */
(function () {
  const CARD_SELECTOR = ".content .card, .content .kpi, .content .mini-card";
  const NAV_SELECTOR = ".nav a, #companyNav a";

  const CARD = { maxDist: 300, lift: 3, tilt: 2.2, scale: 0.004 };
  /* 메뉴: 반경을 좁혀 커서 아래 항목만 따로 떠오름 */
  const NAV = { maxDist: 95, lift: 2, tilt: 0, scale: 0.002 };

  let mx = -9999;
  let my = -9999;
  let raf = 0;
  let zone = null;

  function isNavItem(el) {
    return el.matches(NAV_SELECTOR);
  }

  function cfg(el) {
    return isNavItem(el) ? NAV : CARD;
  }

  function allTargets() {
    if (!zone) return [];
    return [...zone.querySelectorAll(CARD_SELECTOR), ...zone.querySelectorAll(NAV_SELECTOR)];
  }

  function resetCards(cards) {
    cards.forEach((el) => {
      el.style.transform = "";
      el.style.boxShadow = "";
      el.classList.remove("is-floating");
    });
  }

  function tick() {
    raf = 0;
    if (!zone) return;
    allTargets().forEach((card) => {
      const c = cfg(card);
      const r = card.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot(mx - cx, my - cy);
      const t = Math.max(0, 1 - dist / c.maxDist);
      const ease = t * t * (3 - 2 * t);

      if (ease < 0.05) {
        card.style.transform = "";
        card.style.boxShadow = "";
        card.classList.remove("is-floating");
        return;
      }

      const nav = isNavItem(card);
      let transform;
      if (nav) {
        /* 사이드바: 기울임 없이 해당 줄만 살짝 들어 올림 */
        const lift = c.lift * ease;
        const scale = 1 + c.scale * ease;
        transform = `translateY(${(-lift).toFixed(1)}px) scale(${scale.toFixed(4)})`;
      } else {
        const tiltY = ((mx - cx) / (r.width / 2)) * c.tilt * ease;
        const tiltX = -((my - cy) / (r.height / 2)) * c.tilt * ease;
        const lift = c.lift * ease;
        const scale = 1 + c.scale * ease;
        transform =
          `perspective(900px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translateY(${(-lift).toFixed(1)}px) scale(${scale.toFixed(4)})`;
      }

      card.classList.add("is-floating");
      card.style.transform = transform;

      const mul = nav ? 0.55 : 1;
      const shadowY = Math.round(2 + 6 * ease * mul);
      const shadowBlur = Math.round(8 + 12 * ease * mul);
      const shadowA = (0.03 + 0.04 * ease).toFixed(3);
      card.style.boxShadow = `0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,${shadowA})`;
    });
  }

  function onMove(e) {
    mx = e.clientX;
    my = e.clientY;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  window.initFloatingCards = function () {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    zone = document.querySelector(".app");
    if (!zone || zone.dataset.floatBound) return;
    zone.dataset.floatBound = "1";
    zone.addEventListener("mousemove", onMove, { passive: true });
    zone.addEventListener("mouseleave", () => {
      resetCards(allTargets());
      mx = -9999;
      my = -9999;
    });
  };
})();
