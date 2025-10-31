import React, { useEffect, useMemo, useRef, useState } from "react";
import { DayPicker } from "react-day-picker";
import { ko } from "date-fns/locale";
import { format } from "date-fns";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { Calendar, Download, Plus, Trash2, Edit, Check, X } from "lucide-react";
// ⚠️ Next.js(App Router)에서는 전역 CSS를 layout.tsx에서 임포트하세요:
// import 'react-day-picker/dist/style.css'
// (app/layout.tsx 상단에 위 한 줄 추가)

/**
 * MonthlyPlanner_TossStyle.tsx (with Pretty Date Range Picker)
 * - react-day-picker로 "토스 느낌"의 날짜 선택 팝오버 제공 (범위 선택)
 * - dateKey (타임존 안전), 유효성 강화, O(N) 패턴 적용, A4 가로 인쇄 최적화 유지
 */

type Pattern = {
  id: number;
  subjectName: string; // 과목명 (예: 민법, 특허법)
  unit: string; // 단위 (강, 회, 챕터, 단원, 페이지, 또는 커스텀)
  startNum: number; // 시작 번호
  countPerDay: number; // 하루에 몇 개 소화하는지
  days: number[]; // 적용 요일 (0=일~6=토). 빈 배열이면 모든 요일
};

const weekdaysLocal = ["일", "월", "화", "수", "목", "금", "토"] as const;

// 로컬 기준 YYYY-MM-DD 키 (타임존 안전)
const dateKey = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const todayAt00 = () => {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
};

const isSameDay = (a: Date, b: Date) => a.getTime() === b.getTime();
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const escHTML = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export default function MonthlyPlanner_TossStyle() {
  // 날짜 범위(문자열 보관: YYYY-MM-DD)
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  // 팝오버 열림
  const [openPicker, setOpenPicker] = useState(false);

  // 플래너 이름 (PDF 제목용)
  const [plannerName, setPlannerName] = useState<string>("나의 플래너");
  
  // PDF 날짜 표시 형식 (day: 일만, month-day: 월/일)
  const [dateFormat, setDateFormat] = useState<"day" | "month-day">("day");

  // 달력 날짜들 (자정 고정)
  const [calendar, setCalendar] = useState<Date[]>([]);

  // 날짜별 계획 (key=YYYY-MM-DD)
  const [plans, setPlans] = useState<Record<string, string>>({});

  // 패턴
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [showPatternModal, setShowPatternModal] = useState(false);

  // 현재 편집 중 패턴 (모달)
  const [editingPattern, setEditingPattern] = useState<Pattern>({
    id: Date.now(),
    subjectName: "민법",
    unit: "강",
    startNum: 1,
    countPerDay: 1,
    days: [],
  });

  const firstInvalidRef = useRef<HTMLButtonElement | null>(null);
  // DayPicker에서 시작 날짜를 다시 클릭하면 선택 해제하도록 제어하는 플래그
const skipSelectRef = useRef<boolean>(false);
  const hasRange = useMemo(() => Boolean(startDate && endDate), [startDate, endDate]);

  // ======================== Calendar ========================

  const generateCalendar = () => {
    if (!startDate || !endDate) {
      alert("날짜를 선택해주세요");
      firstInvalidRef.current?.focus();
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    if (e < s) {
      alert("종료일이 시작일보다 빠를 수 없어요");
      return;
    }

    const maxSpan = 400;
    const days = Math.floor((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (days > maxSpan) {
      alert(`기간이 너무 깁니다 (최대 ${maxSpan}일)`);
      return;
    }

    const dates: Date[] = [];
    for (let d = new Date(s); d <= e; ) {
      dates.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    setCalendar(dates);
  };

  // ======================== Pattern Logic ========================

  const addOrUpdatePattern = () => {
    setPatterns((prev) => {
      const idx = prev.findIndex((p) => p.id === editingPattern.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...editingPattern };
        return next;
      } else {
        return [...prev, { ...editingPattern, id: Date.now() }];
      }
    });
    setShowPatternModal(false);
  };

  const editPattern = (p: Pattern) => {
    setEditingPattern({ ...p });
    setShowPatternModal(true);
  };

  const removePattern = (id: number) => {
    setPatterns((prev) => prev.filter((p) => p.id !== id));
  };

  const applyAllPatterns = () => {
    if (calendar.length === 0) {
      alert("먼저 캘린더를 생성해주세요");
      return;
    }

    const newPlans: Record<string, string> = {};

    // 패턴별 단일 카운터 준비 (날짜 순서대로 진행)
    const counters = new Map<number, number>();
    patterns.forEach((p) => {
      counters.set(p.id, p.startNum);
    });

    calendar.forEach((date) => {
      const key = dateKey(date);
      const weekday = date.getDay();
      const lines: string[] = [];

      patterns.forEach((p) => {
        // 요일 필터링: 빈 배열이면 전체 요일, 아니면 해당 요일만
        const shouldApply = p.days.length === 0 || p.days.includes(weekday);
        
        if (shouldApply) {
          const current = counters.get(p.id)!;

          let displayText = "";
          if (p.countPerDay === 1) {
            // 하루 1강 - 민법
            displayText = `${p.subjectName} ${current}${p.unit}`;
          } else {
            // 민법 3-5강
            const start = current;
            const end = current + p.countPerDay - 1;
            displayText = `${p.subjectName} ${start}-${end}${p.unit}`;
          }
          
          lines.push(displayText);
          counters.set(p.id, current + p.countPerDay);
        }
      });

      if (lines.length) newPlans[key] = lines.join("\n");
    });

    setPlans(newPlans);
  };

  // ======================== PDF Export ========================

  const exportToPDF = async () => {
    if (calendar.length === 0) {
      alert("먼저 캘린더를 생성해주세요");
      return;
    }

    try {
      const firstDate = calendar[0];
      const lastDate = calendar[calendar.length - 1];
      const fileName = `${plannerName}_${format(firstDate, 'yyyyMMdd', { locale: ko })}.pdf`;

      // PDF 전용 임시 컨테이너 생성
      const pdfContainer = document.createElement('div');
      pdfContainer.style.cssText = `
        position: fixed;
        left: -9999px;
        top: 0;
        width: 1200px;
        background: white;
        padding: 40px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif;
      `;

      const leading = calendar[0].getDay();
      const trailing = (7 - ((leading + calendar.length) % 7)) % 7;

      // HTML 생성
      let gridHTML = `
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0;">
            ${plannerName}
          </h1>
          <p style="font-size: 14px; color: #6b7280; margin-top: 8px;">
            ${format(firstDate, 'yyyy.MM.dd', { locale: ko })} - ${format(lastDate, 'yyyy.MM.dd', { locale: ko })}
          </p>
        </div>
        <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px;">
      `;

      // 요일 헤더 (중앙 정렬)
      weekdaysLocal.forEach((day) => {
        gridHTML += `
          <div style="
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 14px;
            padding: 10px;
            background: #f3f4f6;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            color: #374151;
          ">
            ${day}
          </div>
        `;
      });

      // 빈 셀 (시작 전)
      for (let i = 0; i < leading; i++) {
        gridHTML += `<div style="min-height: 100px;"></div>`;
      }

      // 날짜 셀
      calendar.forEach((date) => {
        const key = dateKey(date);
        const isSunday = date.getDay() === 0;
        const planText = (plans[key] || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        
        // 날짜 표시 형식 결정
        const dateDisplay = dateFormat === "month-day" 
          ? `${date.getMonth() + 1}/${date.getDate()}`
          : String(date.getDate());

        gridHTML += `
          <div style="
            border: 1px solid #d1d5db;
            border-radius: 8px;
            padding: 10px;
            min-height: 100px;
            background: #ffffff;
          ">
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px; color: ${isSunday ? '#dc2626' : '#374151'};">
              ${dateDisplay}
            </div>
            <div style="font-size: 12px; line-height: 1.5; color: #111827; word-break: break-word;">
              ${planText}
            </div>
          </div>
        `;
      });

      // 빈 셀 (끝)
      for (let i = 0; i < trailing; i++) {
        gridHTML += `<div style="min-height: 100px;"></div>`;
      }

      gridHTML += `</div>`;
      pdfContainer.innerHTML = gridHTML;
      document.body.appendChild(pdfContainer);

      // html2canvas로 캡처
      const canvas = await html2canvas(pdfContainer, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true
      });

      // 캡처 완료 후 임시 컨테이너 제거
      document.body.removeChild(pdfContainer);

      // PDF 생성 (A4 가로)
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
      });

      const imgWidth = 297; // A4 가로 길이 (mm)
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, imgWidth, imgHeight);
      pdf.save(fileName);

    } catch (error) {
      console.error('PDF 생성 중 오류:', error);
      alert('PDF 생성에 실패했습니다. 콘솔을 확인해주세요.');
    }
  };

  const clearPlans = () => {
    if (window.confirm("모든 내용(기간, 패턴, 캘린더, 설정)을 초기화하시겠습니까?")) {
      setPlans({});
      setStartDate("");
      setEndDate("");
      setCalendar([]);
      setPatterns([]);
      setPlannerName("나의 플래너");
      setDateFormat("day");
    }
  };
  const autoResize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${clamp(el.scrollHeight, 64, 360)}px`;
  };

  const gridDates = useMemo(() => {
    if (calendar.length === 0) return { leading: 0, trailing: 0 };
    const leading = calendar[0].getDay();
    const trailing = (7 - ((leading + calendar.length) % 7)) % 7;
    return { leading, trailing };
  }, [calendar]);

  // 날짜 범위 텍스트
  const rangeLabel = startDate && endDate
    ? `${startDate} ~ ${endDate}`
    : "날짜 범위를 선택하세요";
  
  useEffect(() => {
  if (!openPicker) return;

  const handleDocMouseDown = (e: MouseEvent) => {
    const target = e.target as Node;
    const inPopover = pickerRef.current?.contains(target);
    const inButton  = toggleBtnRef.current?.contains(target);
    if (!inPopover && !inButton) {
      setOpenPicker(false);
    }
  };

  document.addEventListener("mousedown", handleDocMouseDown);
  return () => document.removeEventListener("mousedown", handleDocMouseDown);
}, [openPicker]);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="mp-wrap">
      <style>{cssReset}</style>
      <div className="container">
        <header className="header">
          <h1 className="title">Monthly Planner</h1>
          <p className="subtitle">미니멀 플래너 · 공유 → PDF 저장 가능</p>
        </header>

        {/* Controls */}
        <section className="panel">
          <div className="control-row">
            {/* 예쁜 날짜 선택 팝오버 */}
            <div className="field" style={{ position: "relative" }}>
              <label>기간 선택</label>
              <button
                className="btn range-btn"
                onClick={() => setOpenPicker((v) => !v)}
                  ref={(el) => { 
                    firstInvalidRef.current = el; 
                    toggleBtnRef.current = el; 
                  }}
                aria-haspopup="dialog"
                aria-expanded={openPicker}
              >
                {rangeLabel}
              </button>

              {openPicker && (
                <div className="popover" role="dialog" aria-modal="true" ref={pickerRef}>
                  <div className="popover-inner">
                    <DayPicker
                      mode="range"
                      numberOfMonths={2}
                      locale={ko}
                      selected={
                        startDate && endDate
                          ? { from: new Date(startDate), to: new Date(endDate) }
                          : startDate
                          ? { from: new Date(startDate), to: undefined }
                          : undefined
                      }
                      onDayClick={(day) => {
                        const key = dateKey(new Date(day));
                        // 시작만 선택된 상태거나, 범위가 완성된 상태에서도
                        // "시작일"을 다시 클릭하면 전체 선택을 해제
                        if (startDate && key === startDate) {
                          setStartDate("");
                          setEndDate("");
                          skipSelectRef.current = true; // 이번 클릭에 따른 onSelect는 무시
                        }
                      }}
                      onSelect={(range) => {
                        // 직전에 onDayClick에서 해제 처리했다면 무시
                        if (skipSelectRef.current) { skipSelectRef.current = false; return; }
                        if (!range) return;
                        const f = range.from ? new Date(range.from) : undefined;
                        const t = range.to ? new Date(range.to) : undefined;
                        if (f) setStartDate(dateKey(f)); else setStartDate("");
                        if (t) setEndDate(dateKey(t)); else setEndDate("");
                      }}
                      weekStartsOn={1}
                      showOutsideDays
                      modifiersStyles={{
                        range_middle: { backgroundColor: 'rgba(59,130,246,0.18)', color: '#e5e7eb' },
                        range_start: { backgroundColor: '#3b82f6', color: '#fff' },
                        range_end: { backgroundColor: '#3b82f6', color: '#fff' }
                      }}
                    />
                    <div className="pop-actions">
                      <button className="btn" onClick={() => { setStartDate(""); setEndDate(""); }}>지우기</button>
                      <button className="btn primary" onClick={() => setOpenPicker(false)}>확인</button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="planner-name">플래너 이름</label>
              <input
                id="planner-name"
                type="text"
                value={plannerName}
                onChange={(e) => setPlannerName(e.target.value)}
                placeholder="플래너"
              />
            </div>

            <div className="field">
              <label htmlFor="date-format">PDF 날짜 표시</label>
              <select
                id="date-format"
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value as "day" | "month-day")}
                style={{
                  background: '#0e0f12',
                  border: '1px solid #23262d',
                  borderRadius: '10px',
                  padding: '10px 12px',
                  color: 'var(--fg)',
                  outline: 'none',
                  minWidth: '120px',
                  cursor: 'pointer'
                }}
              >
                <option value="day">일만 표시 (예: 15)</option>
                <option value="month-day">월/일 표시 (예: 3/15)</option>
              </select>
            </div>

            <div className="buttons">
              <button className="btn primary" onClick={generateCalendar} aria-label="캘린더 생성">
                <Calendar size={16} />
                캘린더 생성
              </button>
              <button className="btn" onClick={() => setShowPatternModal(true)} aria-label="패턴 추가">
                <Plus size={16} />
                패턴 추가
              </button>
              <button className="btn" onClick={applyAllPatterns} aria-label="패턴 전부 적용">
                <Check size={16} />
                패턴 적용
              </button>
              <button className="btn" onClick={clearPlans} aria-label="계획 초기화">
                <Trash2 size={16} />
                내용 초기화
              </button>
              <button className="btn accent" onClick={exportToPDF} aria-label="PDF로 내보내기">
                <Download size={16} />
                PDF 다운로드
              </button>
            </div>
          </div>

          {/* 패턴 리스트 */}
          {patterns.length > 0 && (
            <div className="pattern-list" role="list">
              {patterns.map((p) => {
                const days = p.days.length > 0 ? p.days.sort().map((d) => weekdaysLocal[d]).join(", ") : "전체";
                const exampleText = `하루 ${p.countPerDay}${p.unit} - ${p.subjectName}`;
                
                return (
                  <div className="pattern-item" role="listitem" key={p.id}>
                    <div className="pattern-text">
                      <span className="chip">{exampleText}</span>
                      <span className="dim">요일: {days}</span>
                    </div>
                    <div className="pattern-actions">
                      <button className="btn small" onClick={() => editPattern(p)}>
                        <Edit size={14} />
                        수정
                      </button>
                      <button className="btn small danger" onClick={() => removePattern(p.id)}>
                        <Trash2 size={14} />
                        삭제
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Calendar Grid */}
        {calendar.length > 0 ? (
          <section className="calendar">
            <div className="grid">
              {weekdaysLocal.map((w) => (
                <div className="weekday" key={w} aria-hidden>{w}</div>
              ))}

              {Array.from({ length: gridDates.leading }).map((_, i) => (
                <div className="cell empty" key={`le-${i}`} />
              ))}

              {calendar.map((date) => {
                const key = dateKey(date);
                const isSunday = date.getDay() === 0;
                const isToday = isSameDay(date, todayAt00());
                const value = plans[key] || "";

                return (
                  <div className={`cell ${isSunday ? "sunday" : ""} ${isToday ? "today" : ""}`} key={key}>
                    <div className="cell-head">
                      <div className="day-number">{date.getDate()}</div>
                    </div>
                    <textarea
                      className="cell-text"
                      placeholder="메모를 입력하세요"
                      value={value}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPlans((prev) => ({ ...prev, [key]: v }));
                        autoResize(e.target);
                      }}
                      ref={(el) => autoResize(el)}
                      rows={3}
                    />
                  </div>
                );
              })}

              {Array.from({ length: gridDates.trailing }).map((_, i) => (
                <div className="cell empty" key={`tr-${i}`} />
              ))}
            </div>
          </section>
        ) : (
          <section className="empty-state">
            <div className="empty-card">
              <div className="empty-title">기간을 설정하고 캘린더를 생성해 보세요</div>
              <div className="empty-desc">패턴을 추가하면 날짜에 자동으로 번호가 채워져요</div>
            </div>
          </section>
        )}

        {/* Pattern Modal */}
        {showPatternModal && (
          <div 
            className="modal-backdrop" 
            role="dialog" 
            aria-modal="true"
            onClick={() => setShowPatternModal(false)}
          >
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div className="mh-title">패턴 추가/수정</div>
                <button className="icon-btn" onClick={() => setShowPatternModal(false)} aria-label="닫기">
                  <X size={18} />
                </button>
              </div>
              <div className="modal-body">
                <div className="field full">
                  <label htmlFor="p-subject">과목명</label>
                  <input 
                    id="p-subject" 
                    type="text" 
                    value={editingPattern.subjectName} 
                    onChange={(e) => setEditingPattern((s) => ({ ...s, subjectName: e.target.value }))} 
                    placeholder="예: 민법, 특허법"
                  />
                </div>

                <div className="row-2">
                  <div className="field">
                    <label htmlFor="p-unit">단위</label>
                    <select
                      id="p-unit"
                      value={editingPattern.unit}
                      onChange={(e) => setEditingPattern((s) => ({ ...s, unit: e.target.value }))}
                      style={{
                        background: '#0e0f12',
                        border: '1px solid #23262d',
                        borderRadius: '10px',
                        padding: '10px 12px',
                        color: 'var(--fg)',
                        outline: 'none',
                        width: '100%',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="강">강</option>
                      <option value="회">회</option>
                      <option value="챕터">챕터</option>
                      <option value="단원">단원</option>
                      <option value="페이지">페이지</option>
                      <option value="문제">문제</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="p-cnt">하루 개수</label>
                    <input 
                      id="p-cnt" 
                      type="text" 
                      inputMode="numeric"
                      value={editingPattern.countPerDay === 0 ? '' : editingPattern.countPerDay} 
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '') {
                          setEditingPattern((s) => ({ ...s, countPerDay: 0 }));
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num) && num >= 0) {
                            setEditingPattern((s) => ({ ...s, countPerDay: num }));
                          }
                        }
                      }}
                      onBlur={(e) => {
                        if (editingPattern.countPerDay === 0) {
                          setEditingPattern((s) => ({ ...s, countPerDay: 1 }));
                        }
                      }}
                      placeholder="예: 3"
                    />
                  </div>
                </div>

                <div className="field full">
                  <label htmlFor="p-start">시작 번호</label>
                  <input 
                    id="p-start" 
                    type="text" 
                    inputMode="numeric"
                    value={editingPattern.startNum === 0 ? '' : editingPattern.startNum} 
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '') {
                        setEditingPattern((s) => ({ ...s, startNum: 0 }));
                      } else {
                        const num = parseInt(val, 10);
                        if (!isNaN(num) && num >= 0) {
                          setEditingPattern((s) => ({ ...s, startNum: num }));
                        }
                      }
                    }}
                    onBlur={(e) => {
                      if (editingPattern.startNum === 0) {
                        setEditingPattern((s) => ({ ...s, startNum: 1 }));
                      }
                    }}
                    placeholder="예: 1"
                  />
                  <p className="hint">어디서부터 시작할지 번호를 입력하세요</p>
                </div>

                <div className="field full">
                  <label>요일 선택 (비우면 전체 요일)</label>
                  <div className="chips">
                    {weekdaysLocal.map((w, i) => {
                      const active = editingPattern.days.includes(i);
                      return (
                        <button
                          type="button"
                          key={w}
                          className={`chip-btn ${active ? "on" : ""}`}
                          onClick={() => setEditingPattern((s) => ({ ...s, days: active ? s.days.filter((d) => d !== i) : [...s.days, i] }))}
                        >
                          {w}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={() => setShowPatternModal(false)}>취소</button>
                <button className="btn primary" onClick={addOrUpdatePattern}>저장</button>
              </div>
            </div>
          </div>
        )}

        <footer className="footer"><span className="dim">Shift+Tab/Tab으로 이동 가능 · 입력 시 자동 높이</span></footer>
      </div>
    </div>
  );
}

// ======================== Styles ========================
const cssReset = `
  :root{ --bg:#0b0b0c; --card:#111214; --muted:#9CA3AF; --fg:#E5E7EB; --line:#1f2227; --brand:#2563EB; --brand-weak:#2563eb22; --error:#d92d20; }
  html,body,#root{height:100%}
  body{margin:0;background:var(--bg);color:var(--fg)}
  .mp-wrap{display:flex;min-height:100%}
  .container{max-width:1040px;width:100%;margin:0 auto;padding:24px}
  .header{margin-bottom:16px}
  .title{font-size:28px;margin:0 0 6px;font-weight:800;letter-spacing:-0.2px}
  .subtitle{margin:0;color:var(--muted);font-size:14px}

  .panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:16px;position:relative}
  .control-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
  .field{display:flex;flex-direction:column;gap:6px}
  .field.full{grid-column:1 / -1}
  label{font-size:12px;color:var(--muted)}
  input[type=text], input[type=number]{background:#0e0f12;border:1px solid #23262d;border-radius:10px;padding:10px 12px;color:var(--fg);outline:none;min-width:180px}
  input:focus{border-color:#334155;box-shadow:0 0 0 3px #33415555}

  .buttons{display:flex;gap:8px;flex-wrap:wrap}
  .btn{background:#17181c;border:1px solid #262a31;border-radius:10px;padding:10px 14px;color:var(--fg);cursor:pointer;transition:transform .06s ease, background .2s ease;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{background:#1b1d22}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:#1c2430;border-color:#2b3a50;color:#e6f0ff}
  .btn.primary:hover{background:#223044}
  .btn.accent{background:#1b2333;border-color:#224074;color:#cfe3ff}
  .btn.accent:hover{background:#22314a}
  .btn.small{padding:6px 10px;border-radius:8px;gap:4px}
  .btn.danger{border-color:#42211f;color:#ffd7d3;background:#281414}
  .btn.danger:hover{background:#311918}

  .range-btn{min-width:260px;display:inline-flex;align-items:center;justify-content:space-between;gap:8px}
  .popover{position:absolute; top:64px; left:0; z-index:40;}
  .popover-inner{background:#0f1013;border:1px solid #1f2227;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);padding:12px}
  .pop-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}

  .pattern-list{margin-top:12px;display:flex;flex-direction:column;gap:10px}
  .pattern-item{display:flex;justify-content:space-between;align-items:center;background:#0f1013;border:1px solid #1f2227;padding:10px 12px;border-radius:12px}
  .pattern-text{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .chip{background:#0f1a2e;border:1px solid #1c2e54;padding:4px 8px;border-radius:9999px;font-size:12px;color:#9ec2ff}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
  .dim{color:#9CA3AF;font-size:12px}
  .pattern-actions{display:flex;gap:6px}

  .calendar{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:12px}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
  .weekday{background:#0f1013;border:1px solid #1f2227;padding:8px 0;text-align:center;font-weight:700;border-radius:12px;color:#d1d5db}
  .cell{background:#0f1013;border:1px solid #1f2227;border-radius:12px;padding:8px;min-height:140px;display:flex;flex-direction:column}
  .cell.empty{background:transparent;border:none}
  .cell.today{outline:2px solid var(--brand-weak);background:#0f1320}
  .cell.sunday .day-number{color:#fda4a4}
  .cell-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .day-number{font-weight:700;color:#e5e7eb}
  .cell-text{background:#0b0c0f;border:1px solid #23262d;border-radius:10px;padding:8px 10px;color:var(--fg);outline:none;resize:none;width:100%}
  .cell-text:focus{border-color:#334155;box-shadow:0 0 0 3px #33415555}

  .empty-state{display:flex;align-items:center;justify-content:center}
  .empty-card{background:#0f1013;border:1px solid #1f2227;border-radius:16px;padding:24px;text-align:center}
  .empty-title{font-weight:800;margin-bottom:6px}
  .empty-desc{color:#9CA3AF}

  .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
  .modal{width:min(720px, 100%);background:#0f1013;border:1px solid #1f2227;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.4);display:flex;flex-direction:column}
  .modal-header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #1f2227}
  .mh-title{font-weight:700}
  .icon-btn{background:transparent;border:none;color:#d1d5db;cursor:pointer;font-size:16px}
  .modal-body{padding:16px;display:grid;grid-template-columns:1fr;gap:12px}
  .row-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip-btn{background:#12141a;border:1px solid #222531;border-radius:999px;padding:6px 10px;color:#d1d5db;cursor:pointer}
  .chip-btn.on{background:#17233a;border-color:#203555;color:#cfe3ff}
  .hint{color:#9CA3AF;font-size:12px;margin-top:4px}
  .modal-footer{padding:12px 16px;border-top:1px solid #1f2227;display:flex;justify-content:flex-end;gap:8px}

  .footer{margin-top:16px;color:#9CA3AF;font-size:12px}

  @media (max-width: 720px){
    .row-2{grid-template-columns:1fr}
    .cell{min-height:120px}
    .range-btn{min-width:220px}
  }
  
  /* DayPicker range style overrides (dark + Toss tone) */
  .popover .rdp{--rdp-cell-size:36px}
  .popover .rdp-months{gap:12px}
  .popover .rdp-caption_label{color:#e5e7eb;font-weight:700}
  .popover .rdp-head_cell{color:#9ca3af;font-weight:600}
  .popover .rdp-day{border-radius:8px}
  .popover .rdp-day_outside{opacity:.35}
  .popover .rdp-day_range_start,
  .popover .rdp-day_range_end{
    background:#3b82f6 !important; /* start/end pill */
    color:#fff !important;
  }
  .popover .rdp-day_range_middle{
    background:rgba(59,130,246,.18) !important; /* semi-transparent fill */
    color:#e5e7eb !important;
  }
  .popover .rdp-day_disabled{opacity:.35}
  .popover .rdp-day:hover{box-shadow:inset 0 0 0 1px rgba(59,130,246,.8)}
`;