import React, { useState, useEffect, useRef } from 'react';
import { parsePdfFile } from './utils/pdfParser';
import type { ParsedPDF } from './utils/pdfParser';
import { renderBionicParagraph } from './utils/bionic';
import { saveParsedPDF, getParsedPDF, deleteParsedPDF } from './utils/db';
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
  const [activeBookId, setActiveBookId] = useState<string | null>(null);

  // --- SETTINGS STATE ---
  const [theme, setTheme] = useState<string>('sepia');
  const [fontSize, setFontSize] = useState<number>(19);
  const [lineSpacing, setLineSpacing] = useState<number>(1.65);
  const [fontFamily, setFontFamily] = useState<string>('serif');
  const [isBionic, setIsBionic] = useState<boolean>(false);
  const [isProcessingBionic, setIsProcessingBionic] = useState<boolean>(false);
  const [isZenMode, setIsZenMode] = useState<boolean>(false);
  const [showSidebar, setShowSidebar] = useState<boolean>(false);
  const [layoutMode, setLayoutMode] = useState<'scroll' | 'page'>('scroll');
  const [currentPage, setCurrentPage] = useState<number>(1);

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

  // --- READER SCROLL STATE ---
  const [scrollPercentage, setScrollPercentage] = useState(0);
  const readerMainRef = useRef<HTMLDivElement>(null);
  const paragraphRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // --------------------------------------------------------------------------
  // INITIAL LOADING & SYNC LOGIC
  // --------------------------------------------------------------------------
  useEffect(() => {
    // 1. Load profile from localStorage
    const savedProfile = localStorage.getItem('pdf_reader_profile');
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        setUserProfile(parsed);
        setTempProfileName(parsed.name);
      } catch (e) {
        console.error('Failed to parse local profile', e);
      }
    } else {
      setTempProfileName('Cititor Pasionat');
    }

    // 2. Load recent books metadata from localStorage
    let recents: BookMetadata[] = [];
    const savedRecent = localStorage.getItem('pdf_reader_recent_books');
    if (savedRecent) {
      try {
        recents = JSON.parse(savedRecent);
        setRecentBooks(recents);
      } catch (e) {
        console.error('Failed to parse recent books', e);
      }
    }

    // 3. Load reading settings from localStorage
    const savedSettings = localStorage.getItem('pdf_reader_settings');
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.fontSize) setFontSize(settings.fontSize);
        if (settings.lineSpacing) setLineSpacing(settings.lineSpacing);
        if (settings.fontFamily) setFontFamily(settings.fontFamily);
        if (settings.isBionic !== undefined) setIsBionic(settings.isBionic);
        if (settings.layoutMode !== undefined) setLayoutMode(settings.layoutMode);
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    }

    // 4. Load theme
    const savedTheme = localStorage.getItem('pdf_reader_theme');
    if (savedTheme) {
      setTheme(savedTheme);
    }

    // 5. Load active book from IndexedDB if exists
    const savedActiveId = localStorage.getItem('pdf_reader_active_book_id');
    if (savedActiveId && recents.some(b => b.id === savedActiveId)) {
      setActiveBookId(savedActiveId);
      loadBookOnStartup(savedActiveId, recents);
    }
  }, []);

  const loadBookOnStartup = async (id: string, recentsList: BookMetadata[]) => {
    setIsParsing(true);
    setParseProgress(0);
    try {
      const bookData = await getParsedPDF(id);
      if (bookData) {
        setParsedPdf(bookData);
        
        // Restore last active paragraph and scroll or page position
        const metadata = recentsList.find(b => b.id === id);
        if (metadata) {
          setScrollPercentage(metadata.progressPercentage || 0);
          if (metadata.lastActiveParagraphId) {
            const p = bookData.paragraphs.find(par => par.id === metadata.lastActiveParagraphId);
            if (p) {
              setCurrentPage(p.pageNumber);
              
              // Scroll in scroll mode after a brief timeout
              setTimeout(() => {
                if (readerMainRef.current) {
                  const element = paragraphRefs.current[p.id];
                  if (element) {
                    element.scrollIntoView({ behavior: 'auto', block: 'center' });
                  }
                }
              }, 500);
            }
          }
        }
      } else {
        localStorage.removeItem('pdf_reader_active_book_id');
        setActiveBookId(null);
      }
    } catch (e) {
      console.error('Failed to load active book on startup', e);
    } finally {
      setIsParsing(false);
    }
  };

  // Sync settings back to localStorage whenever they change
  useEffect(() => {
    const settings = { fontSize, lineSpacing, fontFamily, isBionic, layoutMode };
    localStorage.setItem('pdf_reader_settings', JSON.stringify(settings));
  }, [fontSize, lineSpacing, fontFamily, isBionic, layoutMode]);

  // Sync theme to the html/body element
  useEffect(() => {
    document.body.className = '';
    document.body.classList.add(`theme-${theme}`);
    localStorage.setItem('pdf_reader_theme', theme);
  }, [theme]);

  // Handle page turn shortcuts in page mode
  useEffect(() => {
    if (!parsedPdf || layoutMode !== 'page') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if editing user profile in modal
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        goToNextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        goToPrevPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [parsedPdf, layoutMode, currentPage]);

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

      const bookId = `book-${Date.now()}`;
      
      // Save full parsed PDF to IndexedDB for quick persistent loading
      await saveParsedPDF(bookId, parsed);

      // Check if this book title is already in recent books list to restore progress (optional merge)
      const existingBook = recentBooks.find(b => b.title === parsed.title);
      
      const now = new Date().toLocaleDateString('ro-RO', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      let updatedRecents: BookMetadata[] = [];
      if (existingBook) {
        // Move to the top of list, reuse ID to avoid duplicate store entries
        updatedRecents = [
          {
            ...existingBook,
            lastReadDate: now,
          },
          ...recentBooks.filter(b => b.id !== existingBook.id)
        ];
        
        setActiveBookId(existingBook.id);
        localStorage.setItem('pdf_reader_active_book_id', existingBook.id);
        setParsedPdf(parsed);

        // Delete the redundant newly generated DB entry since we reuse the existing one
        await deleteParsedPDF(bookId);

        // Restore position
        setTimeout(() => {
          if (existingBook.lastActiveParagraphId && readerMainRef.current) {
            const element = paragraphRefs.current[existingBook.lastActiveParagraphId];
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }, 500);
      } else {
        const newBook: BookMetadata = {
          id: bookId,
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

        setActiveBookId(bookId);
        localStorage.setItem('pdf_reader_active_book_id', bookId);
        setParsedPdf(parsed);
        setCurrentPage(1);
        setScrollPercentage(0);
      }

      setRecentBooks(updatedRecents);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updatedRecents));

    } catch (e) {
      console.error(e);
      alert('A apărut o eroare la procesarea documentului PDF. Asigură-te că fișierul nu este securizat sau corupt.');
      setIsParsing(false);
    }
  };

  const loadBookFromHistory = async (id: string) => {
    setIsParsing(true);
    setParseProgress(0);
    try {
      const bookData = await getParsedPDF(id);
      if (bookData) {
        setParsedPdf(bookData);
        setActiveBookId(id);
        localStorage.setItem('pdf_reader_active_book_id', id);

        const metadata = recentBooks.find(b => b.id === id);
        if (metadata) {
          setScrollPercentage(metadata.progressPercentage || 0);
          if (metadata.lastActiveParagraphId) {
            const p = bookData.paragraphs.find(par => par.id === metadata.lastActiveParagraphId);
            if (p) {
              setCurrentPage(p.pageNumber);
              
              // Scroll to position in scroll mode
              setTimeout(() => {
                if (readerMainRef.current) {
                  const element = paragraphRefs.current[p.id];
                  if (element) {
                    element.scrollIntoView({ behavior: 'auto', block: 'center' });
                  }
                }
              }, 300);
            }
          }
        }
      } else {
        alert('Cartea selectată nu a fost găsită în baza de date locală.');
      }
    } catch (error) {
      console.error(error);
      alert('A apărut o eroare la încărcarea cărții.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleDeleteBook = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Ești sigur că vrei să ștergi această carte din istoric?')) return;

    try {
      const updated = recentBooks.filter(b => b.id !== id);
      setRecentBooks(updated);
      localStorage.setItem('pdf_reader_recent_books', JSON.stringify(updated));

      await deleteParsedPDF(id);

      if (activeBookId === id) {
        setActiveBookId(null);
        localStorage.removeItem('pdf_reader_active_book_id');
        setParsedPdf(null);
      }
    } catch (error) {
      console.error('Failed to delete book:', error);
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
    if (layoutMode !== 'scroll') return;
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
    if (!parsedPdf || !activeBookId) return;
    const updated = recentBooks.map(b => {
      if (b.id === activeBookId) {
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
  // PAGE NAVIGATION HANDLERS (PAGE MODE)
  // --------------------------------------------------------------------------
  const goToNextPage = () => {
    if (!parsedPdf) return;
    if (currentPage < parsedPdf.totalPages) {
      const nextPage = currentPage + 1;
      setCurrentPage(nextPage);
      const percent = parsedPdf.totalPages > 1 ? Math.round(((nextPage - 1) / (parsedPdf.totalPages - 1)) * 100) : 100;
      setScrollPercentage(percent);

      const firstP = parsedPdf.paragraphs.find(p => p.pageNumber === nextPage);
      if (firstP) {
        updateBookProgress(firstP.id, percent);
      }
    }
  };

  const goToPrevPage = () => {
    if (!parsedPdf) return;
    if (currentPage > 1) {
      const prevPage = currentPage - 1;
      setCurrentPage(prevPage);
      const percent = parsedPdf.totalPages > 1 ? Math.round(((prevPage - 1) / (parsedPdf.totalPages - 1)) * 100) : 100;
      setScrollPercentage(percent);

      const firstP = parsedPdf.paragraphs.find(p => p.pageNumber === prevPage);
      if (firstP) {
        updateBookProgress(firstP.id, percent);
      }
    }
  };

  const toggleBionic = () => {
    setIsProcessingBionic(true);
    setTimeout(() => {
      setIsBionic(prev => !prev);
      setIsProcessingBionic(false);
    }, 120); // allow browser to paint loader first
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
    setParsedPdf(null);
    setIsZenMode(false);
    localStorage.removeItem('pdf_reader_active_book_id');
    setActiveBookId(null);
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
            <div className="brand-icon">
              <img src="/logo.svg" alt="logo" style={{ width: '28px', height: '28px' }} />
            </div>
            <span>read-pdf</span>
          </div>
          <div className="header-actions">
            <span className="user-greeting" style={{ fontSize: '0.95rem', fontWeight: 'bold', color: 'var(--text-secondary)' }}>
              Salut, {userProfile.name}!
            </span>
            <button className="btn" onClick={() => {
              setTempProfileName(userProfile.name);
              setShowProfileModal(true);
            }}>Setări Cont</button>
          </div>
        </header>

        {/* Hero Section */}
        <section className="welcome-hero">
          <h2>Lectură Re-definită în Browser</h2>
          <p>Încarcă orice fișier PDF și transformă-l instantaneu într-o carte digitală captivantă, ușor de citit, cu moduri de focusare, paginare pe coloane și teme confortabile.</p>
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
                  onClick={() => loadBookFromHistory(book.id)}
                >
                  <button 
                    className="delete-book-btn" 
                    onClick={(e) => handleDeleteBook(e, book.id)}
                    title="Șterge din istoric"
                  >
                    ✕
                  </button>
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
            {/* Displaying Current Mode status */}
            <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--text-secondary)' }}>
              {layoutMode === 'scroll' ? '📖 Mod Scroll' : `📄 Pagina ${currentPage} / ${parsedPdf.totalPages}`}
            </span>
          </div>

          <div className="reader-topbar-right">
            <button 
              className={`btn ${isBionic ? 'btn-primary' : ''}`} 
              onClick={toggleBionic}
              title="Activează formatul de citire bionică (bolds initial letters)"
            >
              🧠 Citire Bionică
            </button>
            <button className="btn" onClick={() => setShowSidebar(!showSidebar)}>
              ⚙ Setări Vizuale
            </button>
            <button className="btn btn-primary" onClick={() => setIsZenMode(true)} title="Activează modul focus">
              ✨ Modul Focus
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
        <div className="reader-container" style={{ position: 'relative' }}>
          
          {/* Main article container */}
          <main 
            ref={readerMainRef}
            className={`reader-main ${layoutMode === 'page' ? 'page-mode' : ''}`} 
            onScroll={handleScroll}
          >
            <article 
              className={`reader-article ${layoutMode === 'page' ? 'page-mode' : ''}`}
              style={{
                '--font-active': activeFontClass,
                '--font-size-active': `${fontSize}px`,
                '--line-spacing-active': lineSpacing,
              } as React.CSSProperties}
            >
              {parsedPdf.paragraphs
                .filter(p => layoutMode === 'scroll' || p.pageNumber === currentPage)
                .map((p) => {
                  return (
                    <div 
                      key={p.id}
                      ref={el => { paragraphRefs.current[p.id] = el; }}
                      className="reader-paragraph-wrapper"
                      style={{ transition: 'background-color 0.2s ease' }}
                    >
                      {layoutMode === 'scroll' && (
                        <span className="page-indicator-badge">
                          Pag. {p.pageNumber}
                        </span>
                      )}
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

          {/* Navigation Controls in Page Mode */}
          {layoutMode === 'page' && (
            <div className="page-navigation-bar">
              <button 
                className="btn page-nav-btn" 
                onClick={goToPrevPage} 
                disabled={currentPage === 1}
                title="Pagina precedentă (Tasta Săgeată Stânga / Sus)"
              >
                ◀ Înapoi
              </button>
              <span className="page-nav-info">
                Pagina {currentPage} din {parsedPdf.totalPages}
              </span>
              <button 
                className="btn page-nav-btn" 
                onClick={goToNextPage} 
                disabled={currentPage === parsedPdf.totalPages}
                title="Pagina următoare (Tasta Space / Săgeată Dreapta / Jos)"
              >
                Înainte ▶
              </button>
            </div>
          )}

          {/* Settings Sidebar */}
          {showSidebar && !isZenMode && (
            <aside className="reader-sidebar">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Ajustări Vizuale</h3>
                <button className="btn btn-icon-only" onClick={() => setShowSidebar(false)}>✕</button>
              </div>

              {/* View Layout Mode (Scroll vs Page) */}
              <div className="sidebar-section">
                <span className="sidebar-label">Mod Vizualizare</span>
                <div className="choice-grid">
                  <button 
                    className={`btn ${layoutMode === 'scroll' ? 'btn-primary' : ''}`} 
                    onClick={() => {
                      setLayoutMode('scroll');
                      // Restore scroll after layout mode toggle
                      setTimeout(() => {
                        const activeP = parsedPdf.paragraphs.find(p => p.pageNumber === currentPage);
                        if (activeP && readerMainRef.current) {
                          const element = paragraphRefs.current[activeP.id];
                          if (element) {
                            element.scrollIntoView({ behavior: 'auto', block: 'center' });
                          }
                        }
                      }, 100);
                    }}
                  >
                    Scroll Clasic
                  </button>
                  <button 
                    className={`btn ${layoutMode === 'page' ? 'btn-primary' : ''}`} 
                    onClick={() => setLayoutMode('page')}
                  >
                    Pagini / Coloane
                  </button>
                </div>
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
              title="Ieși din modul focus"
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
            <h4 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Statistici Lectură read-pdf:</h4>
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
      {isProcessingBionic && (
        <div className="bionic-loading-overlay">
          <div className="bionic-spinner"></div>
          <p>Se optimizează textul pentru citire bionică...</p>
        </div>
      )}
    </>
  );
}

export default App;
