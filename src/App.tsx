import React, { useState, useEffect, useRef } from 'react';
import { parsePdfFile } from './utils/pdfParser';
import type { ParsedPDF } from './utils/pdfParser';
import { renderBionicParagraph } from './utils/bionic';
import './App.css';

interface BookMetadata {
  id: string;
  title: string;
  totalPages: number;
  lastReadDate: string;
  progressPercentage: number;
  lastActiveParagraphId: string | null;
}

interface UserProfile {
  name: string;
  totalBooksParsed: number;
  preferredTheme: string;
  joinedDate: string;
}

function App() {
  // --- APP STATE ---
  const [parsedPdf, setParsedPdf] = useState<ParsedPDF | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  // --- SETTINGS STATE ---
  const [theme, setTheme] = useState<string>('sepia');
  const [fontSize, setFontSize] = useState<number>(19);
  const [lineSpacing, setLineSpacing] = useState<number>(1.65);
  const [fontFamily, setFontFamily] = useState<string>('serif');
  const [isBionic, setIsBionic] = useState<boolean>(false);
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const [showSidebar, setShowSidebar] = useState<boolean>(false);

  // --- PROFILE & SYNC STATE ---
  const [userProfile, setUserProfile] = useState<UserProfile>({
    name: 'Cititor Pasionat',
    totalBooksParsed: 0,
    preferredTheme: 'sepia',
    joinedDate: new Date().toLocaleDateString('ro-RO'),
  });
  const [recentBooks, setRecentBooks] = useState<BookMetadata[]>([]);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [tempProfileName, setTempProfileName] = useState('');

  // --- TTS (TEXT-TO-SPEECH) STATE ---
  const [ttsIsSpeaking, setTtsIsSpeaking] = useState(false);
  const [ttsIsPaused, setTtsIsPaused] = useState(false);
  const [ttsRate, setTtsRate] = useState<number>(1);
  const [ttsCurrentParagraphId, setTtsCurrentParagraphId] = useState<string | null>(null);
  const ttsNextIndexRef = useRef<number>(0);

  // --- READER SCROLL STATE ---
  const [scrollPercentage, setScrollPercentage] = useState(0);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // --------------------------------------------------------------------------
  // INITIAL LOADING & SYNC LOGIC
  // --------------------------------------------------------------------------
  useEffect(() => {
    // Load profile from localStorage
    const savedProfile = localStorage.getItem('pdf_reader_profile');
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        setUserProfile(parsed);
        setTempProfileName(parsed.name);
        if (parsed.preferredTheme) {
          setTheme(parsed.preferredTheme);
        }
      } catch (e) {
        console.error('Failed to parse local profile', e);
      }
    } else {
      setTempProfileName('Cititor Pasionat');
    }

    // Load recent books metadata from localStorage
    const savedRecent = localStorage.getItem('pdf_reader_recent_books');
    if (savedRecent) {
      try {
        setRecentBooks(JSON.parse(savedRecent));
      } catch (e) {
        console.error('Failed to parse recent books', e);
      }
    }

    // Load reading settings from localStorage
    const savedSettings = localStorage.getItem('pdf_reader_settings');
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.fontSize) setFontSize(settings.fontSize);
        if (settings.lineSpacing) setLineSpacing(settings.lineSpacing);
        if (settings.fontFamily) setFontFamily(settings.fontFamily);
        if (settings.isBionic !== undefined) setIsBionic(settings.isBionic);
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }
  }, []);

  // Sync settings back to localStorage whenever they change
  useEffect(() => {
    const settings = { fontSize, lineSpacing, fontFamily, isBionic };
    localStorage.setItem('pdf_reader_settings', JSON.stringify(settings));
  }, [fontSize, lineSpacing, fontFamily, isBionic]);

  // Sync theme to the html/body element
  useEffect(() => {
    document.body.className = '';
    document.body.classList.add(`theme-${theme}`);
    
    // Save updated preferred theme in user profile
    const updatedProfile = { ...userProfile, preferredTheme: theme };
    setUserProfile(updatedProfile);
    localStorage.setItem('pdf_reader_profile', JSON.stringify(updatedProfile));
  }, [theme]);

  // --------------------------------------------------------------------------
  // PARSING PDF FILE
  // --------------------------------------------------------------------------
  const handlePdfUpload = async (uploadedFile: File) => {
    if (uploadedFile.type !== 'application/pdf') {
      alert('Te rugăm să încarci un fișier de tip PDF valid.');
      return;
    }

    setIsParsing(true);
    setParseProgress(0);

    try {
      const parsed = await parsePdfFile(uploadedFile, (progress) => {
        setParseProgress(progress);
      });

      setParsedPdf(parsed);
      setIsParsing(false);

      // Check if this book is already in recent books list to restore progress
      const existingBook = recentBooks.find(b => b.title === parsed.title);
      
      // Update or insert book in local history
      const now = new Date().toLocaleDateString('ro-RO', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      let updatedRecents: BookMetadata[] = [];
      if (existingBook) {
        // Move to the top of list
        updatedRecents = [
          {
            ...existingBook,
            lastReadDate: now,
          },
          ...recentBooks.filter(b => b.title !== parsed.title)
        ];
        
        // Restore scroll position after DOM rendering
        setTimeout(() => {
          if (existingBook.lastActiveParagraphId && readerMainRef.current) {
            const element = paragraphRefs.current[existingBook.lastActiveParagraphId];
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTtsCurrentParagraphId(existingBook.lastActiveParagraphId);
            }
          }
        }, 500);
      } else {
        const newBook: BookMetadata = {
          id: `book-${Date.now()}`,
          title: parsed.title,
          totalPages: parsed.totalPages,
          lastReadDate: now,
          progressPercentage: 0,
          lastActiveParagraphId: parsed.paragraphs[0]?.id || null,
        };
        updatedRecents = [newBook, ...recentBooks];

        // Increment total parsed books count in profile
        const updatedProfile = {
          ...userProfile,
          totalBooksParsed: userProfile.totalBooksParsed + 1
        };
        setUserProfile(updatedProfile);
        localStorage.setItem('pdf_reader_profile', JSON.stringify(updatedProfile));
      }

      setRecentBooks(updatedRecents);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updatedRecents));

    } catch (e) {
      console.error(e);
      alert('A apărut o eroare la procesarea documentului PDF. Asigură-te că fișierul nu este securizat sau corupt.');
      setIsParsing(false);
    }
  };

  // Drag and Drop Handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handlePdfUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handlePdfUpload(e.target.files[0]);
    }
  };

  // --------------------------------------------------------------------------
  // SCROLL PROGRESS TRACKING
  // --------------------------------------------------------------------------
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const progress = (target.scrollTop / (target.scrollHeight - target.clientHeight)) * 100;
    const currentPercent = Math.round(progress || 0);
    setScrollPercentage(currentPercent);

    // Find the currently visible paragraph to update the bookmark/active paragraph
    if (parsedPdf) {
      const containerRect = target.getBoundingClientRect();
      const containerMiddle = containerRect.top + containerRect.height / 3;

      let closestId: string | null = null;
      let minDistance = Infinity;

      parsedPdf.paragraphs.forEach(p => {
        const el = paragraphRefs.current[p.id];
        if (el) {
          const rect = el.getBoundingClientRect();
          const distance = Math.abs(rect.top - containerMiddle);
          if (distance < minDistance) {
            minDistance = distance;
            closestId = p.id;
          }
        }
      });

      if (closestId) {
        updateBookProgress(closestId, currentPercent);
      }
    }
  };

  const updateBookProgress = (paragraphId: string, percent: number) => {
    if (!parsedPdf) return;
    const updated = recentBooks.map(b => {
      if (b.title === parsedPdf.title) {
        return {
          ...b,
          progressPercentage: Math.max(b.progressPercentage, percent),
          lastActiveParagraphId: paragraphId
        };
      }
      return b;
    });
    setRecentBooks(updated);
    localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));
  };

  // --------------------------------------------------------------------------
  // TEXT-TO-SPEECH (TTS) PLAYBACK ENGINE
  // --------------------------------------------------------------------------
  // Cancel Speech Synthesis on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  const speakParagraph = (index: number) => {
    if (!parsedPdf || index < 0 || index >= parsedPdf.paragraphs.length) {
      stopTts();
      return;
    }

    window.speechSynthesis.cancel();

    const paragraph = parsedPdf.paragraphs[index];
    setTtsCurrentParagraphId(paragraph.id);
    ttsNextIndexRef.current = index + 1;

    // Scroll paragraph smoothly into view so reader matches speech
    const element = paragraphRefs.current[paragraph.id];
    if (element && readerMainRef.current) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const utterance = new SpeechSynthesisUtterance(paragraph.text);
    
    // Attempt to set Romanian voice or default to standard
    const voices = window.speechSynthesis.getVoices();
    const roVoice = voices.find(v => v.lang.startsWith('ro'));
    if (roVoice) {
      utterance.voice = roVoice;
    }
    
    utterance.rate = ttsRate;

    utterance.onstart = () => {
      setTtsIsSpeaking(true);
      setTtsIsPaused(false);
    };

    utterance.onend = () => {
      // Auto-play next paragraph
      if (ttsNextIndexRef.current < parsedPdf.paragraphs.length) {
        speakParagraph(ttsNextIndexRef.current);
      } else {
        stopTts();
      }
    };

    utterance.onerror = (e) => {
      // If error is not 'interrupted' or 'canceled' (which are triggered by manual actions)
      if (e.error !== 'interrupted' && e.error !== 'canceled') {
        console.error('SpeechSynthesis error:', e);
        stopTts();
      }
    };

    window.speechSynthesis.speak(utterance);
  };

  const playTts = () => {
    if (ttsIsPaused) {
      window.speechSynthesis.resume();
      setTtsIsPaused(false);
      setTtsIsSpeaking(true);
      return;
    }

    if (parsedPdf) {
      // Start from current visible or last speaking paragraph
      let startIdx = 0;
      if (ttsCurrentParagraphId) {
        const idx = parsedPdf.paragraphs.findIndex(p => p.id === ttsCurrentParagraphId);
        if (idx !== -1) startIdx = idx;
      }
      speakParagraph(startIdx);
    }
  };

  const pauseTts = () => {
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      setTtsIsPaused(true);
      setTtsIsSpeaking(false);
    }
  };

  const stopTts = () => {
    window.speechSynthesis.cancel();
    setTtsIsSpeaking(false);
    setTtsIsPaused(false);
    setTtsCurrentParagraphId(null);
  };

  const handleTtsRateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newRate = parseFloat(e.target.value);
    setTtsRate(newRate);
    if (ttsIsSpeaking) {
      // Restart speaking with new rate
      const idx = parsedPdf?.paragraphs.findIndex(p => p.id === ttsCurrentParagraphId) ?? -1;
      if (idx !== -1) speakParagraph(idx);
    }
  };

  // --------------------------------------------------------------------------
  // USER PROFILE SAVE LOGIC
  // --------------------------------------------------------------------------
  const saveProfile = () => {
    if (tempProfileName.trim() === '') return;
    const updated = {
      ...userProfile,
      name: tempProfileName.trim()
    };
    setUserProfile(updated);
    localStorage.setItem('pdf_reader_profile', JSON.stringify(updated));
    setShowProfileModal(false);
  };

  // --------------------------------------------------------------------------
  // CLOSING THE READER
  // --------------------------------------------------------------------------
  const handleBackToDashboard = () => {
    stopTts();
    setParsedPdf(null);
    setIsZenMode(false);
  };

  // --------------------------------------------------------------------------
  // RENDER SECTIONS
  // --------------------------------------------------------------------------

  // Dashboard / Upload Screen
  const renderDashboard = () => {
    return (
      <div className="app-container">
        {/* Top bar */}
        <header className="app-header">
          <div className="brand">
            <div className="brand-icon">📚</div>
            <span>AuraReader</span>
          </div>
          <div className="header-actions">
            <div className="user-badge" onClick={() => {
              setTempProfileName(userProfile.name);
              setShowProfileModal(true);
            }} style={{ cursor: 'pointer' }}>
              👤 {userProfile.name}
            </div>
            <button className="btn" onClick={() => setShowProfileModal(true)}>Setări Cont</button>
          </div>
        </header>

        {/* Hero Section */}
        <section className="welcome-hero">
          <h2>Lectură Re-definită în Browser</h2>
          <p>Încarcă orice fișier PDF și transformă-l instantaneu într-o carte digitală captivantă, ușor de citit, cu moduri de focusare, teme confortabile și asistență audio.</p>
        </section>

        {/* Drag and Drop Zone */}
        <div className="dropzone-container">
          {isParsing ? (
            <div className="loading-box">
              <h3>📖 Se extrage textul din documentul tău...</h3>
              <p>Analizăm structura paginilor și re-creăm paragrafele pentru o citire optimă.</p>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${parseProgress}%` }}></div>
              </div>
              <p className="sidebar-label">{parseProgress}% finalizat</p>
            </div>
          ) : (
            <div 
              className={`dropzone ${dragActive ? 'active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <div className="dropzone-icon">📥</div>
              <div className="dropzone-text">
                <h3>Trage și plasează fișierul PDF aici</h3>
                <p>Sau dă click pentru a alege un fișier de pe calculatorul tău.</p>
              </div>
              <input 
                id="file-upload"
                type="file"
                className="file-input"
                accept=".pdf"
                onChange={handleFileChange}
              />
            </div>
          )}
        </div>

        {/* Library History Section */}
        {recentBooks.length > 0 && (
          <section className="recent-library">
            <h3 className="section-title">📂 Continuă Lectura (Istoric Recente)</h3>
            <div className="recent-grid">
              {recentBooks.map((book) => (
                <div 
                  key={book.id} 
                  className="recent-card"
                  onClick={() => {
                    // Gracefully prompt them to reload their file to maintain safe file loading constraints
                    const fileInput = document.getElementById('file-upload') as HTMLInputElement;
                    if (fileInput) {
                      fileInput.click();
                      // We save a temporary trigger to load progress once file matches
                      alert(`Te rugăm să selectezi fișierul "${book.title}.pdf" pentru a continua lectura de la progresul tău de ${book.progressPercentage}%.`);
                    }
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="card-icon">📄</span>
                    <span className="page-indicator-badge" style={{ opacity: 1, position: 'static' }}>
                      {book.totalPages} pagini
                    </span>
                  </div>
                  <div className="card-details">
                    <h4>{book.title}</h4>
                    <p>Ultima accesare: {book.lastReadDate}</p>
                    <p style={{ marginTop: '0.25rem', fontWeight: 'bold', color: 'var(--accent-color)' }}>
                      Progres: {book.progressPercentage}%
                    </p>
                    <div className="card-progress-bar-container">
                      <div className="card-progress-bar" style={{ width: `${book.progressPercentage}%` }}></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  };

  // Main Reader Workspace View
  const renderReader = () => {
    if (!parsedPdf) return null;

    // Font styles mapper
    let activeFontClass = 'var(--font-serif)';
    if (fontFamily === 'sans') activeFontClass = 'var(--font-sans)';
    if (fontFamily === 'dyslexic') activeFontClass = 'var(--font-dyslexic)';

    return (
      <div className={`reader-wrapper ${isZenMode ? 'zen-mode' : ''}`}>
        
        {/* Top Control Bar */}
        <header className="reader-topbar">
          <div className="reader-topbar-left">
            <button className="btn" onClick={handleBackToDashboard}>
              ⬅ Înapoi
            </button>
            <div className="reader-title" title={parsedPdf.title}>
              {parsedPdf.title}
            </div>
          </div>

          <div className="reader-topbar-center">
            {/* TTS Toolbar */}
            <div className="tts-panel">
              {ttsIsSpeaking ? (
                <button className="btn btn-primary btn-icon-only" onClick={pauseTts} title="Pune pauză">
                  ⏸
                </button>
              ) : (
                <button className="btn btn-primary btn-icon-only" onClick={playTts} title="Ascultă textul (Citire Audio)">
                  ▶
                </button>
              )}
              {(ttsIsSpeaking || ttsIsPaused) && (
                <button className="btn btn-icon-only" onClick={stopTts} title="Oprește citirea">
                  ⏹
                </button>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span className="tts-rate-label">Viteză:</span>
                <select 
                  className="tts-rate-select" 
                  value={ttsRate}
                  onChange={handleTtsRateChange}
                >
                  <option value="0.75">0.75x</option>
                  <option value="1">1.0x</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                  <option value="1.8">1.8x</option>
                </select>
              </div>
            </div>
          </div>

          <div className="reader-topbar-right">
            <button 
              className={`btn ${isBionic ? 'btn-primary' : ''}`} 
              onClick={() => setIsBionic(!isBionic)}
              title="Activează formatul de citire bionică (bolds initial letters)"
            >
              🧠 Citire Bionică
            </button>
            <button className="btn" onClick={() => setShowSidebar(!showSidebar)}>
              ⚙ Setări Vizuale
            </button>
            <button className="btn btn-primary" onClick={() => setIsZenMode(true)} title="Activează modul focus zen">
              ✨ Zen Focus
            </button>
          </div>
        </header>

        {/* Zen Mode Progress Bar */}
        {isZenMode && (
          <div className="zen-progress-bar-container">
            <div className="zen-progress-bar" style={{ width: `${scrollPercentage}%` }}></div>
          </div>
        )}

        {/* Reader Container */}
        <div className="reader-container">
          
          {/* Main article container */}
          <main 
            ref={readerMainRef}
            className="reader-main" 
            onScroll={handleScroll}
          >
            <article 
              className="reader-article"
              style={{
                '--font-active': activeFontClass,
                '--font-size-active': `${fontSize}px`,
                '--line-spacing-active': lineSpacing,
              } as React.CSSProperties}
            >
              {parsedPdf.paragraphs.map((p, index) => {
                const isCurrentlySpoken = p.id === ttsCurrentParagraphId;
                return (
                  <div 
                    key={p.id}
                    ref={el => { paragraphRefs.current[p.id] = el; }}
                    className={`reader-paragraph-wrapper ${isCurrentlySpoken ? 'spoken-active' : ''}`}
                    onClick={() => {
                      // Click paragraph to read aloud! This is an amazing user experience feature
                      speakParagraph(index);
                    }}
                    style={{ cursor: 'pointer' }}
                    title="Apasă pentru a asculta acest paragraf"
                  >
                    <span className="page-indicator-badge">
                      Pag. {p.pageNumber}
                    </span>
                    {isBionic ? (
                      renderBionicParagraph(p.text)
                    ) : (
                      <p>{p.text}</p>
                    )}
                  </div>
                );
              })}
            </article>
          </main>

          {/* Settings Sidebar */}
          {showSidebar && !isZenMode && (
            <aside className="reader-sidebar">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Ajustări Vizuale</h3>
                <button className="btn btn-icon-only" onClick={() => setShowSidebar(false)}>✕</button>
              </div>

              {/* Themes Selector */}
              <div className="sidebar-section">
                <span className="sidebar-label">Tema de Lectură</span>
                <div className="theme-selector">
                  <button 
                    className={`theme-btn theme-btn-sepia ${theme === 'sepia' ? 'active' : ''}`} 
                    onClick={() => setTheme('sepia')}
                    title="Sepia Hârtie"
                  >
                    🍂
                  </button>
                  <button 
                    className={`theme-btn theme-btn-light ${theme === 'light' ? 'active' : ''}`} 
                    onClick={() => setTheme('light')}
                    title="Luminos"
                  >
                    ☀️
                  </button>
                  <button 
                    className={`theme-btn theme-btn-dark ${theme === 'dark' ? 'active' : ''}`} 
                    onClick={() => setTheme('dark')}
                    title="Întunecat"
                  >
                    🌙
                  </button>
                  <button 
                    className={`theme-btn theme-btn-forest ${theme === 'forest' ? 'active' : ''}`} 
                    onClick={() => setTheme('forest')}
                    title="Midnight Forest"
                  >
                    🌲
                  </button>
                  <button 
                    className={`theme-btn theme-btn-sunset ${theme === 'sunset' ? 'active' : ''}`} 
                    onClick={() => setTheme('sunset')}
                    title="Sunset Oasis"
                  >
                    🌆
                  </button>
                </div>
              </div>

              {/* Font Size controls */}
              <div className="sidebar-section">
                <span className="sidebar-label">Dimensiune Text ({fontSize}px)</span>
                <div className="font-size-controls">
                  <button className="btn font-size-btn" onClick={() => setFontSize(Math.max(14, fontSize - 2))}>A-</button>
                  <button className="btn font-size-btn" onClick={() => setFontSize(Math.min(36, fontSize + 2))}>A+</button>
                </div>
              </div>

              {/* Font Style selectors */}
              <div className="sidebar-section">
                <span className="sidebar-label">Tip Font</span>
                <div className="choice-grid">
                  <button 
                    className={`btn ${fontFamily === 'serif' ? 'btn-primary' : ''}`} 
                    onClick={() => setFontFamily('serif')}
                  >
                    Serif (Carte)
                  </button>
                  <button 
                    className={`btn ${fontFamily === 'sans' ? 'btn-primary' : ''}`} 
                    onClick={() => setFontFamily('sans')}
                  >
                    Sans-Serif
                  </button>
                </div>
                <button 
                  className={`btn ${fontFamily === 'dyslexic' ? 'btn-primary' : ''}`} 
                  onClick={() => setFontFamily('dyslexic')}
                  style={{ marginTop: '0.25rem', width: '100%' }}
                >
                  Font Ultra-Lizibil (Dyslexic)
                </button>
              </div>

              {/* Line spacing selection */}
              <div className="sidebar-section">
                <span className="sidebar-label">Distanțiere Linii</span>
                <div className="choice-grid">
                  <button 
                    className={`btn ${lineSpacing === 1.4 ? 'btn-primary' : ''}`} 
                    onClick={() => setLineSpacing(1.4)}
                  >
                    Compactă
                  </button>
                  <button 
                    className={`btn ${lineSpacing === 1.65 ? 'btn-primary' : ''}`} 
                    onClick={() => setLineSpacing(1.65)}
                  >
                    Normală
                  </button>
                </div>
                <button 
                  className={`btn ${lineSpacing === 2.0 ? 'btn-primary' : ''}`} 
                  onClick={() => setLineSpacing(2.0)}
                  style={{ marginTop: '0.25rem', width: '100%' }}
                >
                  Aerisită (2.0)
                </button>
              </div>

              {/* Progress Panel */}
              <div className="sidebar-section" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                <span className="sidebar-label">Progres Lectură</span>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 'bold' }}>
                  <span>Finalizat:</span>
                  <span>{scrollPercentage}%</span>
                </div>
                <div className="card-progress-bar-container">
                  <div className="card-progress-bar" style={{ width: `${scrollPercentage}%` }}></div>
                </div>
              </div>

            </aside>
          )}

          {/* Zen Focus Mode Exit Overlay button */}
          {isZenMode && (
            <button 
              className="btn btn-primary zen-exit-btn" 
              onClick={() => setIsZenMode(false)}
              title="Ieși din modul focus zen"
            >
              🚪 Ieși din Mod Focus
            </button>
          )}

        </div>
      </div>
    );
  };

  // Profile Customization Modal Dialog
  const renderProfileModal = () => {
    if (!showProfileModal) return null;
    return (
      <div className="modal-backdrop">
        <div className="modal-content">
          <div className="modal-header">
            <h3>👤 Personalizare Profil Local</h3>
            <button className="btn btn-icon-only" onClick={() => setShowProfileModal(false)}>✕</button>
          </div>
          <div className="form-group">
            <label htmlFor="user-name-input">Numele Tău de Cititor</label>
            <input 
              id="user-name-input"
              type="text" 
              className="form-input"
              value={tempProfileName}
              onChange={(e) => setTempProfileName(e.target.value)}
              placeholder="Ex: Mihai, Elena, etc."
            />
          </div>
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Statistici Lectură AuraReader:</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.85rem' }}>
              <div>📚 Cărți procesate:</div>
              <div style={{ fontWeight: 'bold' }}>{userProfile.totalBooksParsed}</div>
              <div>📅 Membru din:</div>
              <div style={{ fontWeight: 'bold' }}>{userProfile.joinedDate}</div>
              <div>🎨 Temă activă:</div>
              <div style={{ fontWeight: 'bold', textTransform: 'capitalize' }}>{theme}</div>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => setShowProfileModal(false)}>Anulează</button>
            <button className="btn btn-primary" onClick={saveProfile}>Salvează</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {parsedPdf ? renderReader() : renderDashboard()}
      {renderProfileModal()}
    </>
  );
}

export default App;
