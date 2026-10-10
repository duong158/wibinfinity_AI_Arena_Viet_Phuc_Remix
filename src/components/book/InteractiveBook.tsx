/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * 3D Sketchbook Multi-Strip Bending Engine
 * Based on Meng To's Sketchbook page-curl mechanism (https://threeui.com/css/sketchbook, MIT License).
 * Adapted for Nếp Việt interactive traditional costume sketchbook.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface BookPageContent {
  pageNumber: number;
  category: string;
  title: string;
  subtitle: string;
  content: string;
  footnote?: string;
  sourceId?: string;
  illustrationSilhouette?: 'ao_dai' | 'ao_ngu_than' | 'ao_tu_than' | 'phu_kien';
  actionPreset?: string;
  actionLabel?: string;
  isFinalPage?: boolean;
}

export interface BookSpreadData {
  id: string;
  title: string;
  leftPage: BookPageContent;
  rightPage: BookPageContent;
}

interface InteractiveBookProps {
  spreads: BookSpreadData[];
  currentSpreadIndex: number;
  onSpreadChange: (newIndex: number) => void;
  onOpenSourceModal: (sourceId: string) => void;
  onStartStylingPreset?: (presetFamilyId: string) => void;
  onGoToStudio?: () => void;
}

// 18 dải nối tiếp chuẩn theo công thức hình học gốc để tạo vòng cung uốn cong liên tục mượt mà
const STRIP_COUNT = 18;
// Độ uốn cong cực đại của trang giấy (radians, ~34.38 độ)
const BETA = 0.6;

interface ActiveTurn {
  dir: 'next' | 'prev';
  fromIndex: number;
  toIndex: number;
}

interface DragState {
  x0: number;
  dir: 'next' | 'prev';
  width: number;
  moved: number;
  tPrev: number;
  vel: number;
}

export const InteractiveBook: React.FC<InteractiveBookProps> = ({
  spreads,
  currentSpreadIndex,
  onSpreadChange,
  onOpenSourceModal,
  onStartStylingPreset,
  onGoToStudio,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const curlRef = useRef<HTMLDivElement>(null);
  const stripRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Trạng thái cấp cao (chỉ render lại khi bắt đầu hoặc kết thúc lật trang)
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [viewMode, setViewMode] = useState<'3d' | 'flat'>('3d');
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    return typeof window !== 'undefined' ? window.innerWidth < 768 : false;
  });
  const [isReducedMotion, setIsReducedMotion] = useState<boolean>(false);

  // Chế độ debug phát triển nội bộ
  const [debugOptions, setDebugOptions] = useState<{ progress?: number; colorStrips?: boolean }>({});
  const [showDebugOverlay, setShowDebugOverlay] = useState<boolean>(false);
  const [debugColorStrips, setDebugColorStrips] = useState<boolean>(false);
  const [debugFrozenDir, setDebugFrozenDir] = useState<'next' | 'prev'>('next');

  // Refs cập nhật DOM trực tiếp 60 FPS cho overlay debug
  const debugProgressTextRef = useRef<HTMLSpanElement>(null);
  const debugAnglesTextRef = useRef<HTMLSpanElement>(null);
  const debugStateTextRef = useRef<HTMLSpanElement>(null);

  // Refs điều khiển khung hình và vật lý tức thời (không gây re-render React ở mỗi frame)
  const progressRef = useRef<number>(0);
  const dragRef = useRef<DragState | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const pageWidthRef = useRef<number>(400);
  const bookWidthRef = useRef<number>(800);

  // Cập nhật kích thước sách vào CSS variables
  const updateLayoutGeometry = useCallback(() => {
    if (!bookRef.current) return;
    const bw = bookRef.current.clientWidth;
    const pw = Math.floor(bw / 2);
    const sw = pw / STRIP_COUNT;

    bookWidthRef.current = bw;
    pageWidthRef.current = pw;

    bookRef.current.style.setProperty('--bw', `${bw}px`);
    bookRef.current.style.setProperty('--pw', `${pw}px`);
    bookRef.current.style.setProperty('--sw', `${sw.toFixed(2)}px`);
    bookRef.current.style.setProperty('--n', `${STRIP_COUNT}`);
  }, []);

  // Lắng nghe thay đổi kích thước cửa sổ và kiểm tra màn hình di động
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      updateLayoutGeometry();
    };

    updateLayoutGeometry();
    window.addEventListener('resize', handleResize);

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setIsReducedMotion(mediaQuery.matches);
    const motionHandler = (e: MediaQueryListEvent) => setIsReducedMotion(e.matches);
    mediaQuery.addEventListener('change', motionHandler);

    return () => {
      window.removeEventListener('resize', handleResize);
      mediaQuery.removeEventListener('change', motionHandler);
    };
  }, [updateLayoutGeometry]);

  // Hủy animation frame khi component unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  // Đăng ký API debug dành riêng cho môi trường phát triển (không hiện nút trên UI)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __setBookTurnDebug?: (progress?: number, colorStrips?: boolean) => void }).__setBookTurnDebug = (
        progress?: number,
        colorStrips?: boolean
      ) => {
        setDebugOptions({ progress, colorStrips });
        if (progress !== undefined) {
          const nextIdx = Math.min(spreads.length - 1, currentSpreadIndex + 1);
          setActiveTurn({
            dir: 'next',
            fromIndex: currentSpreadIndex,
            toIndex: nextIdx,
          });
          progressRef.current = progress;
          setTimeout(() => applyTurn(progress), 0);
        } else {
          setActiveTurn(null);
        }
      };
    }

    return () => {
      if (typeof window !== 'undefined') {
        delete (window as unknown as { __setBookTurnDebug?: unknown }).__setBookTurnDebug;
      }
    };
  }, [currentSpreadIndex, spreads.length]);

  // Nếu mục lục bên ngoài đổi currentSpreadIndex trong khi đang có animation, hủy lượt lật an toàn
  const lastIndexPropRef = useRef<number>(currentSpreadIndex);
  useEffect(() => {
    if (lastIndexPropRef.current !== currentSpreadIndex) {
      lastIndexPropRef.current = currentSpreadIndex;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      dragRef.current = null;
      activePointerIdRef.current = null;
      setActiveTurn(null);
    }
  }, [currentSpreadIndex]);

  // Áp dụng góc xoay toàn tờ và độ cong các khớp dải trực tiếp lên DOM
  const applyTurn = useCallback((t: number) => {
    const curlEl = curlRef.current;
    if (!curlEl) return;

    // Tách góc xoay quanh gáy (th) và độ uốn cung tròn giữa các dải (beta)
    const th = Math.PI * t;
    const beta = BETA * Math.sin(Math.PI * t);
    const D = 180 / Math.PI;
    const tt = th + beta;
    const td = (2 * beta) / STRIP_COUNT;

    curlEl.style.setProperty('--tt', `${(tt * D).toFixed(2)}deg`);
    curlEl.style.setProperty('--td', `${(td * D).toFixed(3)}deg`);
    curlEl.style.setProperty('--shade', Math.sin(Math.PI * t).toFixed(3));

    if (bookRef.current) {
      bookRef.current.style.setProperty('--shade', Math.sin(Math.PI * t).toFixed(3));
    }

    // Cập nhật text thời gian thực cho overlay debug
    if (debugProgressTextRef.current) {
      debugProgressTextRef.current.textContent = t.toFixed(3);
    }
    if (debugAnglesTextRef.current) {
      debugAnglesTextRef.current.textContent = `tt: ${(tt * D).toFixed(1)}° | td: ${(td * D).toFixed(2)}° | beta: ${(beta * D).toFixed(1)}°`;
    }

    // Cập nhật sắc độ và dải ánh sáng liên tục cho từng khớp
    for (let i = 0; i < stripRefs.current.length; i++) {
      const el = stripRefs.current[i];
      if (!el) continue;
      const l1 = Math.abs(Math.cos(tt - i * td));
      const l2 = Math.abs(Math.cos(tt - (i + 1) * td));
      el.style.setProperty('--lit', l1.toFixed(3));
      el.style.setProperty('--a1', ((1 - l1) * 0.55).toFixed(3));
      el.style.setProperty('--a2', ((1 - l2) * 0.55).toFixed(3));
    }
  }, []);

  // Thiết lập biến CSS ngay khi tờ lật được mount
  useEffect(() => {
    if (activeTurn) {
      applyTurn(progressRef.current);
    }
  }, [activeTurn, applyTurn]);

  // Vòng lặp mô phỏng lò xo vật lý (Spring loop) đưa trang giấy về vị trí đích
  const animateTo = useCallback((target: number, onDone: () => void) => {
    const k = 155; // Độ cứng lò xo
    const c = 22;  // Hệ số giảm chấn
    let v = dragRef.current ? dragRef.current.vel : 0;
    let currentT = progressRef.current;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - lastTime) / 1000 || 0.016);
      lastTime = now;

      const x = currentT - target;
      v += (-k * x - c * v) * dt;
      currentT += v * dt;
      progressRef.current = currentT;

      if (Math.abs(currentT - target) < 0.002 && Math.abs(v) < 0.02) {
        progressRef.current = target;
        applyTurn(target);
        animationFrameRef.current = null;
        onDone();
      } else {
        applyTurn(currentT);
        animationFrameRef.current = requestAnimationFrame(tick);
      }
    };

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = requestAnimationFrame(tick);
  }, [applyTurn]);

  // Kích hoạt lật trang bằng nút hoặc phím tắt
  const triggerFlip = useCallback((dir: 'next' | 'prev') => {
    if (activeTurn !== null) return;
    if (dir === 'next' && currentSpreadIndex >= spreads.length - 1) return;
    if (dir === 'prev' && currentSpreadIndex <= 0) return;

    if (isReducedMotion || viewMode === 'flat' || isMobile) {
      const nextIndex = dir === 'next' ? currentSpreadIndex + 1 : currentSpreadIndex - 1;
      onSpreadChange(nextIndex);
      return;
    }

    updateLayoutGeometry();
    const toIndex = dir === 'next' ? currentSpreadIndex + 1 : currentSpreadIndex - 1;

    progressRef.current = 0;
    setActiveTurn({
      dir,
      fromIndex: currentSpreadIndex,
      toIndex,
    });

    animateTo(1, () => {
      onSpreadChange(toIndex);
      setActiveTurn(null);
    });
  }, [activeTurn, currentSpreadIndex, spreads.length, isReducedMotion, viewMode, isMobile, updateLayoutGeometry, animateTo, onSpreadChange]);

  // Hỗ trợ phím mũi tên trái/phải
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        triggerFlip('next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        triggerFlip('prev');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [triggerFlip]);

  // Thao tác bắt đầu kéo (Pointer Down)
  const handlePointerDown = (e: React.PointerEvent, dir: 'next' | 'prev') => {
    if (activeTurn !== null) return;
    if (activePointerIdRef.current !== null) return;

    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('a')) return;

    if (dir === 'next' && currentSpreadIndex >= spreads.length - 1) return;
    if (dir === 'prev' && currentSpreadIndex <= 0) return;

    if (isReducedMotion || viewMode === 'flat' || isMobile) {
      const nextIndex = dir === 'next' ? currentSpreadIndex + 1 : currentSpreadIndex - 1;
      onSpreadChange(nextIndex);
      return;
    }

    updateLayoutGeometry();

    activePointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Bỏ qua lỗi trình duyệt nếu không hỗ trợ capture
    }

    const fromIndex = currentSpreadIndex;
    const toIndex = dir === 'next' ? fromIndex + 1 : fromIndex - 1;

    dragRef.current = {
      x0: e.clientX,
      dir,
      width: pageWidthRef.current || 400,
      moved: 0,
      tPrev: performance.now(),
      vel: 0,
    };

    progressRef.current = 0;
    setActiveTurn({
      dir,
      fromIndex,
      toIndex,
    });
  };

  // Di chuyển con trỏ trong lúc kéo (Pointer Move)
  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    if (!dragRef.current || !activeTurn) return;

    const dx = e.clientX - dragRef.current.x0;
    dragRef.current.moved = Math.max(dragRef.current.moved, Math.abs(dx));

    // Khoảng cách kéo tiêu chuẩn: 65% bề rộng một trang hoàn tất 100% vòng cung
    const raw = (dragRef.current.dir === 'next' ? -dx : dx) / (dragRef.current.width * 0.65);
    const t = Math.max(0, Math.min(1, raw));

    const now = performance.now();
    const dt = Math.max(0.001, (now - dragRef.current.tPrev) / 1000);
    dragRef.current.vel = (t - progressRef.current) / dt;
    dragRef.current.tPrev = now;

    progressRef.current = t;
    applyTurn(t);
  };

  // Kết thúc thao tác kéo (Pointer Up / Cancel)
  const handlePointerEnd = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Bỏ qua
    }

    if (!dragRef.current || !activeTurn) return;
    const d = dragRef.current;
    dragRef.current = null;

    if (d.moved < 8) {
      // Cú nhấp chuột ngắn, thực hiện lật toàn trang
      animateTo(1, () => {
        onSpreadChange(activeTurn.toIndex);
        setActiveTurn(null);
      });
      return;
    }

    // Đánh giá ngưỡng lật: vượt qua 42% quãng đường hoặc có vận tốc vuốt dứt khoát
    const shouldComplete = progressRef.current > 0.42 || d.vel > 0.85;

    if (shouldComplete) {
      animateTo(1, () => {
        onSpreadChange(activeTurn.toIndex);
        setActiveTurn(null);
      });
    } else {
      animateTo(0, () => {
        setActiveTurn(null);
      });
    }
  };

  // Các hàm điều khiển ghim tiến độ cho chế độ debug
  const handleFreezeStep = (stepVal: number) => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    updateLayoutGeometry();
    const toIndex = debugFrozenDir === 'next'
      ? Math.min(spreads.length - 1, currentSpreadIndex + 1)
      : Math.max(0, currentSpreadIndex - 1);

    progressRef.current = stepVal;
    setActiveTurn({
      dir: debugFrozenDir,
      fromIndex: currentSpreadIndex,
      toIndex,
    });
    setTimeout(() => {
      applyTurn(stepVal);
      if (debugStateTextRef.current) {
        debugStateTextRef.current.textContent = `Giữ cố định t = ${stepVal.toFixed(2)} (${debugFrozenDir})`;
      }
    }, 0);
  };

  const handleResetFreeze = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    progressRef.current = 0;
    applyTurn(0);
    setActiveTurn(null);
    if (debugStateTextRef.current) {
      debugStateTextRef.current.textContent = 'Nghỉ (Idle)';
    }
  };

  // Dựng chuỗi 18 dải lồng nhau (Nested Strip Chain)
  const renderStripChain = (index: number, frontPage: BookPageContent, backPage: BookPageContent, dir: 'next' | 'prev'): React.ReactNode => {
    if (index >= STRIP_COUNT) return null;
    const isEdge = index === STRIP_COUNT - 1;
    // Độ lệch nội dung: trang phải tính từ gáy (index), trang trái tính từ mép (N - 1 - index)
    const frontOffsetIndex = dir === 'next' ? index : STRIP_COUNT - 1 - index;
    const backOffsetIndex = dir === 'next' ? STRIP_COUNT - 1 - index : index;
    const isStripColored = debugColorStrips || debugOptions.colorStrips;

    return (
      <div
        key={index}
        ref={(el) => {
          stripRefs.current[index] = el;
        }}
        className={`sb-strip ${isEdge ? 'edge' : ''}`}
      >
        {/* Mặt trước của dải */}
        <div
          className="sb-face front border-t border-b border-[#DED7CB]"
          style={isStripColored ? { backgroundColor: index % 2 === 0 ? '#ffcccc' : '#ccffcc' } : undefined}
        >
          {isStripColored && (
            <div className="absolute top-1 left-1 z-30 pointer-events-none bg-[#302C27] text-[#FFFCF5] font-mono text-[9px] px-1 py-0.5 rounded-xs leading-none shadow-xs border border-white/20">
              #{index}
            </div>
          )}
          <div
            className="sb-face-inner p-8 md:p-10 pointer-events-none"
            style={{ left: `calc(-1 * ${frontOffsetIndex} * var(--sw))` }}
          >
            <PageContentRenderer page={frontPage} onOpenSourceModal={onOpenSourceModal} />
          </div>
          <div className="sb-sh" />
          <div className="sb-gl" />
        </div>

        {/* Mặt sau của dải (lật 180 độ, nội dung hiển thị xuôi chiều) */}
        <div
          className="sb-face back border-t border-b border-[#DED7CB]"
          style={isStripColored ? { backgroundColor: index % 2 === 0 ? '#ccccff' : '#ffffcc' } : undefined}
        >
          {isStripColored && (
            <div className="absolute top-1 left-1 z-30 pointer-events-none bg-[#302C27] text-[#FFFCF5] font-mono text-[9px] px-1 py-0.5 rounded-xs leading-none shadow-xs border border-white/20">
              #{index}
            </div>
          )}
          <div
            className="sb-face-inner p-8 md:p-10 pointer-events-none"
            style={{ left: `calc(-1 * ${backOffsetIndex} * var(--sw))` }}
          >
            <PageContentRenderer page={backPage} onOpenSourceModal={onOpenSourceModal} />
          </div>
          <div className="sb-sh" />
          <div className="sb-gl" />
        </div>

        {/* Khớp nối tiếp theo */}
        {renderStripChain(index + 1, frontPage, backPage, dir)}
      </div>
    );
  };

  const currentSpread = spreads[currentSpreadIndex];
  const turnDir = activeTurn?.dir || 'next';
  const fromSpread = activeTurn ? spreads[activeTurn.fromIndex] : currentSpread;
  const toSpread = activeTurn ? spreads[activeTurn.toIndex] : null;
  const isTurning = activeTurn !== null && toSpread !== null;

  // Xác định chính xác hai trang nền tĩnh ngay từ đầu (Loại bỏ hoàn toàn nhảy nội dung giữa chừng)
  const leftUnderlayPage = isTurning && toSpread
    ? turnDir === 'next'
      ? fromSpread.leftPage
      : toSpread.leftPage
    : currentSpread.leftPage;

  const rightUnderlayPage = isTurning && toSpread
    ? turnDir === 'next'
      ? toSpread.rightPage
      : fromSpread.rightPage
    : currentSpread.rightPage;

  // Nội dung hai mặt của tờ giấy đang lật (an toàn khi ở trạng thái nghỉ)
  const turningFrontPage = isTurning
    ? turnDir === 'next'
      ? fromSpread.rightPage
      : fromSpread.leftPage
    : currentSpread.rightPage;

  const turningBackPage = isTurning && toSpread
    ? turnDir === 'next'
      ? toSpread.leftPage
      : toSpread.rightPage
    : currentSpread.leftPage;

  return (
    <div className="w-full flex flex-col items-center select-none" ref={containerRef}>
      {/* Thanh trạng thái và công cụ điều khiển chế độ */}
      <div className="w-full flex items-center justify-between text-xs text-[#71685E] pb-2 px-1">
        <span className="italic">
          {isMobile
            ? 'Thiết bị di động: Chế độ đọc phẳng trang sách tối ưu cảm ứng.'
            : 'Kéo nhẹ mép trang để uốn cong lật sách, hoặc dùng phím mũi tên trái / phải.'}
        </span>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowDebugOverlay(!showDebugOverlay)}
            className={`px-2.5 py-1 border rounded text-xs font-medium transition ${
              showDebugOverlay
                ? 'bg-[#302C27] text-[#FFFCF5] border-[#302C27]'
                : 'border-[#DED7CB] bg-[#FFFCF5] hover:bg-[#F0EAE1] text-[#302C27]'
            }`}
          >
            {showDebugOverlay ? 'Ẩn debug hình học' : 'Kiểm tra debug'}
          </button>
          {!isMobile && (
            <button
              onClick={() => setViewMode(viewMode === '3d' ? 'flat' : '3d')}
              className="px-2.5 py-1 border border-[#DED7CB] bg-[#FFFCF5] hover:bg-[#F0EAE1] rounded text-[#302C27] font-medium transition"
            >
              {viewMode === '3d' ? 'Chuyển đọc phẳng' : 'Chuyển sách 3D'}
            </button>
          )}
        </div>
      </div>

      {/* ================= BẢNG DEBUG OVERLAY HÌNH HỌC (DEBUG HUD) ================= */}
      {showDebugOverlay && (
        <div className="w-full max-w-5xl mb-3 p-3 bg-[#302C27] text-[#FFFCF5] rounded-lg shadow-xl border border-[#DED7CB]/40 font-mono text-xs">
          {/* Hàng 1: Kích thước khung hình sách, chỉ số dải và progress */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/15 pb-2 mb-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <div>
                <span className="text-[#DED7CB]/70">Khung sách:</span>{' '}
                <span className="font-semibold text-white">{bookWidthRef.current}px</span>
              </div>
              <div>
                <span className="text-[#DED7CB]/70">Trang:</span>{' '}
                <span className="font-semibold text-white">{pageWidthRef.current}px</span>
              </div>
              <div>
                <span className="text-[#DED7CB]/70">Bề rộng dải:</span>{' '}
                <span className="font-semibold text-white">{(pageWidthRef.current / STRIP_COUNT).toFixed(2)}px</span>
              </div>
              <div>
                <span className="text-[#DED7CB]/70">Số dải:</span>{' '}
                <span className="font-semibold text-white">{STRIP_COUNT} dải</span>
              </div>
            </div>

            <div className="flex items-center gap-x-3">
              <div>
                <span className="text-[#DED7CB]/70">Trạng thái:</span>{' '}
                <span ref={debugStateTextRef} className="font-semibold text-[#FFFCF5]">
                  {isTurning ? `Đang lật (${turnDir})` : 'Nghỉ (Idle)'}
                </span>
              </div>
              <div className="flex items-center space-x-1.5">
                <span className="text-[#DED7CB]/70">Progress (t):</span>{' '}
                <span ref={debugProgressTextRef} className="font-bold text-[#A94D3C] bg-white px-2 py-0.5 rounded text-[11px]">
                  {progressRef.current.toFixed(3)}
                </span>
              </div>
            </div>
          </div>

          {/* Hàng 2: Các mốc ghim tiến độ để kiểm tra hình học và khớp nối */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[#DED7CB]/70 text-[11px] mr-1">Đặt cố định progress:</span>
              {[0, 0.25, 0.5, 0.75, 1].map((step) => (
                <button
                  key={step}
                  onClick={() => handleFreezeStep(step)}
                  className="px-2 py-0.5 bg-[#453F39] hover:bg-[#5A524A] text-white rounded text-[11px] transition font-medium border border-white/10"
                >
                  t = {step.toFixed(2)}
                </button>
              ))}
              <button
                onClick={handleResetFreeze}
                className="px-2 py-0.5 bg-[#A94D3C] hover:bg-[#8F3F30] text-white rounded text-[11px] transition font-medium ml-1"
              >
                Trở lại
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setDebugFrozenDir((d) => (d === 'next' ? 'prev' : 'next'))}
                className="px-2 py-0.5 border border-white/20 hover:bg-white/10 rounded text-[11px] text-[#DED7CB] transition"
              >
                Hướng: {debugFrozenDir === 'next' ? 'Lật tiến (Next)' : 'Lật lùi (Prev)'}
              </button>
              <button
                onClick={() => setDebugColorStrips((v) => !v)}
                className={`px-2 py-0.5 rounded text-[11px] transition font-medium ${
                  debugColorStrips
                    ? 'bg-[#71806A] text-white'
                    : 'bg-[#453F39] text-[#DED7CB] hover:bg-[#5A524A]'
                }`}
              >
                Tô màu & Đánh số dải: {debugColorStrips ? 'Bật' : 'Tắt'}
              </button>
            </div>
          </div>

          {/* Hàng 3: Góc xoay thời gian thực */}
          <div className="mt-2 pt-1.5 border-t border-white/10 text-[11px] text-[#DED7CB]/80 flex flex-wrap items-center justify-between gap-1">
            <span>
              Góc uốn thời gian thực:{' '}
              <span ref={debugAnglesTextRef} className="text-white font-semibold">
                tt: 0.0° | td: 0.00° | beta: 0.0°
              </span>
            </span>
            <span className="text-[10px] text-[#DED7CB]/60">
              Kiểm tra hình học 18 dải: Bật "Tô màu & Đánh số dải" để thấy rõ khớp nối #0 (gáy) đến #17 (mép)
            </span>
          </div>
        </div>
      )}

      {/* KHUNG CUỐN SỔ (3D Perspective Container) */}
      <div
        ref={bookRef}
        className={`relative w-full max-w-5xl min-h-[580px] bg-[#FFFCF5] border border-[#DED7CB] rounded-lg shadow-2xl ${
          viewMode === '3d' && !isMobile ? 'sb-book-container' : ''
        }`}
        style={{
          // Khởi tạo kích thước mặc định cho biến CSS
          ['--bw' as string]: '800px',
          ['--pw' as string]: '400px',
          ['--sw' as string]: `${(400 / STRIP_COUNT).toFixed(2)}px`,
          ['--n' as string]: `${STRIP_COUNT}`,
        }}
      >
        {/* Lớp bóng chiếu rãnh gáy sách khi đang lật */}
        <div className="sb-gutter-shade left hidden md:block" />
        <div className="sb-gutter-shade right hidden md:block" />

        {/* Nếp gáy trung tâm */}
        <div className="hidden md:block absolute top-0 bottom-0 left-1/2 w-8 -translate-x-1/2 pointer-events-none z-30 bg-gradient-to-r from-transparent via-[#302C27]/12 to-transparent" />

        {/* ================= HAI TRANG NỀN TĨNH CỐ ĐỊNH ================= */}
        <div className="grid grid-cols-1 md:grid-cols-2 w-full h-full min-h-[580px]">
          {/* TRANG TRÁI TĨNH */}
          <div
            className="p-8 md:p-10 flex flex-col justify-between border-b md:border-b-0 md:border-r border-[#DED7CB] bg-[#FFFCF5] relative cursor-grab active:cursor-grabbing"
            onPointerDown={(e) => handlePointerDown(e, 'prev')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            <PageContentRenderer
              page={leftUnderlayPage}
              onOpenSourceModal={onOpenSourceModal}
              onStartStylingPreset={onStartStylingPreset}
              onGoToStudio={onGoToStudio}
            />

            {/* Mép bắt thao tác kéo trang trước */}
            <div className="absolute top-0 bottom-0 left-0 w-10 hover:bg-[#A94D3C]/5 transition" />
          </div>

          {/* TRANG PHẢI TĨNH */}
          <div
            className="p-8 md:p-10 flex flex-col justify-between bg-[#FFFCF5] relative cursor-grab active:cursor-grabbing"
            onPointerDown={(e) => handlePointerDown(e, 'next')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            <PageContentRenderer
              page={rightUnderlayPage}
              onOpenSourceModal={onOpenSourceModal}
              onStartStylingPreset={onStartStylingPreset}
              onGoToStudio={onGoToStudio}
            />

            {/* Mép bắt thao tác kéo trang sau */}
            <div className="absolute top-0 bottom-0 right-0 w-10 hover:bg-[#A94D3C]/5 transition" />
          </div>
        </div>

        {/* ================= TỜ LẬT 3D ĐA DẢI (TURNING LEAF) ================= */}
        {viewMode === '3d' && !isMobile && isTurning && (
          <div
            ref={curlRef}
            className={`sb-curl ${turnDir}`}
            aria-hidden="true"
          >
            {renderStripChain(0, turningFrontPage, turningBackPage, turnDir)}
          </div>
        )}
      </div>

      {/* ================= THANH ĐIỀU HƯỚNG DƯỚI CUỐN SỔ ================= */}
      <div className="w-full flex items-center justify-between mt-6 px-2">
        <button
          onClick={() => triggerFlip('prev')}
          disabled={currentSpreadIndex === 0 || activeTurn !== null}
          className={`py-2 px-5 rounded border text-xs font-medium transition ${
            currentSpreadIndex === 0 || activeTurn !== null
              ? 'border-[#DED7CB] text-[#71685E]/40 cursor-not-allowed bg-[#F7F4ED]'
              : 'border-[#DED7CB] bg-[#FFFCF5] hover:bg-[#F0EAE1] text-[#302C27] shadow-sm'
          }`}
        >
          Trang trước
        </button>

        {/* Danh sách nút các cặp trang */}
        <div className="flex flex-col items-center">
          <div className="flex items-center space-x-1.5 mb-1.5">
            {spreads.map((s, idx) => (
              <button
                key={s.id}
                onClick={() => {
                  if (activeTurn === null && idx !== currentSpreadIndex) {
                    onSpreadChange(idx);
                  }
                }}
                className={`w-6 h-6 rounded-full text-[11px] font-medium transition flex items-center justify-center ${
                  idx === currentSpreadIndex
                    ? 'bg-[#302C27] text-[#FFFCF5]'
                    : 'bg-[#FFFCF5] border border-[#DED7CB] text-[#71685E] hover:bg-[#F0EAE1]'
                }`}
              >
                {idx + 1}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-[#71685E]">
            {currentSpread.title} (Trang {currentSpreadIndex * 2 + 1} - {currentSpreadIndex * 2 + 2})
          </span>
        </div>

        <button
          onClick={() => triggerFlip('next')}
          disabled={currentSpreadIndex >= spreads.length - 1 || activeTurn !== null}
          className={`py-2 px-5 rounded border text-xs font-medium transition ${
            currentSpreadIndex >= spreads.length - 1 || activeTurn !== null
              ? 'border-[#DED7CB] text-[#71685E]/40 cursor-not-allowed bg-[#F7F4ED]'
              : 'border-[#DED7CB] bg-[#FFFCF5] hover:bg-[#F0EAE1] text-[#302C27] shadow-sm'
          }`}
        >
          Trang sau
        </button>
      </div>
    </div>
  );
};

// ================= COMPONENT HIỂN THỊ NỘI DUNG MỘT TRANG SÁCH =================
interface PageContentRendererProps {
  page: BookPageContent;
  onOpenSourceModal: (sourceId: string) => void;
  onStartStylingPreset?: (presetFamilyId: string) => void;
  onGoToStudio?: () => void;
}

const PageContentRenderer: React.FC<PageContentRendererProps> = ({
  page,
  onOpenSourceModal,
  onStartStylingPreset,
  onGoToStudio,
}) => {
  return (
    <div className="flex flex-col justify-between h-full">
      <div>
        <div className="flex items-center justify-between text-xs text-[#71685E] border-b border-[#DED7CB]/60 pb-2 mb-4">
          <span className="uppercase tracking-widest font-medium">{page.category}</span>
          <span>Trang {page.pageNumber}</span>
        </div>

        <h2 className="text-2xl md:text-3xl font-semibold text-[#302C27] font-serif-title mb-1">
          {page.title}
        </h2>
        <p className="text-sm text-[#A94D3C] font-medium mb-3 italic">
          {page.subtitle}
        </p>

        {/* Trình bày hình phác họa trang phục trên các trang thị giác */}
        {page.illustrationSilhouette && (
          <div className="my-3 p-3 bg-[#F7F4ED] border border-[#DED7CB] rounded flex items-center justify-between">
            <div className="text-xs text-[#71685E]">
              <span className="font-semibold text-[#302C27] block mb-0.5">Phác họa hình thái</span>
              {page.illustrationSilhouette === 'ao_dai' && 'Tà đôi buông rủ qua gối, chiết eo thanh thoát, xẻ cao.'}
              {page.illustrationSilhouette === 'ao_ngu_than' && 'Cổ đứng lập lĩnh cao, năm khuy cài lệch phải, tà con che ngực.'}
              {page.illustrationSilhouette === 'ao_tu_than' && 'Bốn thân vải mộc, vạt trước buông lửng hoặc buộc vạt, yếm đào.'}
              {page.illustrationSilhouette === 'phu_kien' && 'Nón quai thao, nón lá, khăn đóng xếp nếp và quạt nan tre.'}
            </div>
            <div className="w-12 h-16 border border-[#DED7CB] bg-[#FFFCF5] rounded flex items-center justify-center text-[10px] text-[#A94D3C] font-semibold text-center uppercase tracking-tighter px-1">
              {page.illustrationSilhouette === 'ao_dai' ? 'Áo dài' : page.illustrationSilhouette === 'ao_ngu_than' ? 'Ngũ thân' : page.illustrationSilhouette === 'ao_tu_than' ? 'Tứ thân' : 'Phụ kiện'}
            </div>
          </div>
        )}

        <div className="text-sm leading-relaxed text-[#302C27] whitespace-pre-line font-normal">
          {page.content}
        </div>

        {/* Nút tác vụ đặc biệt trên các trang cuối hoặc trang giới thiệu */}
        {page.actionPreset && onStartStylingPreset && (
          <div className="mt-4 p-3 bg-[#F7F4ED] border border-[#DED7CB] rounded">
            <button
              onClick={() => onStartStylingPreset(page.actionPreset!)}
              className="w-full py-2 px-4 bg-[#71806A] hover:bg-[#5C6B56] text-[#FFFCF5] text-xs font-semibold rounded tracking-wide transition text-center shadow-sm"
            >
              {page.actionLabel || 'Thử phối bộ này'}
            </button>
          </div>
        )}

        {page.isFinalPage && onGoToStudio && (
          <div className="mt-5 p-4 bg-[#F7F4ED] border border-[#DED7CB] rounded text-center">
            <div className="text-sm font-serif-title font-semibold text-[#302C27] mb-1.5">
              Sẵn sàng sáng tạo phong cách riêng?
            </div>
            <p className="text-xs text-[#71685E] mb-3">
              Bước vào studio thời trang 2D với đầy đủ công cụ đổi màu, phụ kiện và phân tích văn hóa.
            </p>
            <button
              onClick={onGoToStudio}
              className="w-full py-2.5 px-5 bg-[#A94D3C] hover:bg-[#8F3F30] text-[#FFFCF5] text-xs font-semibold rounded tracking-wider uppercase transition shadow-md"
            >
              Bắt đầu phối Việt phục
            </button>
          </div>
        )}
      </div>

      <div className="mt-5 pt-3 border-t border-[#DED7CB]/60 flex items-center justify-between text-xs">
        {page.sourceId ? (
          <div className="flex items-center space-x-3">
            <button
              onClick={() => onOpenSourceModal(page.sourceId!)}
              className="text-[#71806A] hover:text-[#53604E] underline font-medium"
            >
              Đọc thêm chuyên sâu
            </button>
          </div>
        ) : (
          <span className="text-[#71685E] italic">
            {page.footnote || 'Nếp Việt Sketchbook'}
          </span>
        )}
        <span className="text-[#71685E] font-medium">{page.pageNumber}</span>
      </div>
    </div>
  );
};
