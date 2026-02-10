import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, ChevronUp, ChevronDown } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from '../types';

export interface SearchResult {
  pageIndex: number;
  itemIndex: number;
  text: string;
}

interface SearchBarProps {
  isOpen: boolean;
  onClose: () => void;
  document: PDFDocument | null;
  onNavigateToPage: (page: number) => void;
}

const SearchBar: React.FC<SearchBarProps> = ({
  isOpen,
  onClose,
  document,
  onNavigateToPage,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  // Clear results when document changes
  useEffect(() => {
    setResults([]);
    setCurrentResultIndex(-1);
    setQuery('');
  }, [document]);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!document || !searchQuery.trim()) {
      setResults([]);
      setCurrentResultIndex(-1);
      return;
    }

    setSearching(true);
    const searchLower = searchQuery.toLowerCase();
    const found: SearchResult[] = [];

    try {
      const dataCopy = new Uint8Array(document.pdfData);
      const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();

        textContent.items.forEach((item: any, idx: number) => {
          if (item.str && item.str.toLowerCase().includes(searchLower)) {
            found.push({
              pageIndex: i,
              itemIndex: idx,
              text: item.str,
            });
          }
        });
      }
    } catch (e) {
      console.error('Search error:', e);
    }

    setResults(found);
    setCurrentResultIndex(found.length > 0 ? 0 : -1);
    if (found.length > 0) {
      onNavigateToPage(found[0].pageIndex);
    }
    setSearching(false);
  }, [document, onNavigateToPage]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuery = e.target.value;
    setQuery(newQuery);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      performSearch(newQuery);
    }, 300);
  }, [performSearch]);

  const navigateResult = useCallback((direction: 'next' | 'prev') => {
    if (results.length === 0) return;

    let newIndex: number;
    if (direction === 'next') {
      newIndex = currentResultIndex < results.length - 1 ? currentResultIndex + 1 : 0;
    } else {
      newIndex = currentResultIndex > 0 ? currentResultIndex - 1 : results.length - 1;
    }

    setCurrentResultIndex(newIndex);
    onNavigateToPage(results[newIndex].pageIndex);
  }, [results, currentResultIndex, onNavigateToPage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        navigateResult('prev');
      } else {
        navigateResult('next');
      }
    }
  }, [onClose, navigateResult]);

  if (!isOpen) return null;

  return (
    <div className="search-bar">
      <div className="search-bar-input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="search-bar-input"
          placeholder="Find in document..."
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <span className="search-bar-count">
            {searching ? '...' : results.length === 0 ? 'No results' : `${currentResultIndex + 1} of ${results.length}`}
          </span>
        )}
      </div>
      <button
        className="search-bar-btn"
        onClick={() => navigateResult('prev')}
        disabled={results.length === 0}
        title="Previous (Shift+Enter)"
      >
        <ChevronUp size={16} />
      </button>
      <button
        className="search-bar-btn"
        onClick={() => navigateResult('next')}
        disabled={results.length === 0}
        title="Next (Enter)"
      >
        <ChevronDown size={16} />
      </button>
      <button
        className="search-bar-btn"
        onClick={onClose}
        title="Close (Esc)"
      >
        <X size={16} />
      </button>
    </div>
  );
};

export default SearchBar;
