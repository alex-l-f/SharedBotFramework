// Minimal SCORM LMS shim so e-learning (Articulate Rise) pages boot inside the
// same-origin viewer iframe: they look for these functions on window.top.

declare global {
  interface Window {
    IsLmsPresent?: () => boolean;
    GetDataChunk?: () => string;
    SetDataChunk?: (data: string) => boolean;
    getCourseTitle?: () => string;
  }
}

export function installScormShim(): void {
  window.IsLmsPresent = function () {
    return true;
  };
  window.GetDataChunk = function () {
    return sessionStorage.getItem('scorm-datachunk') || '';
  };
  window.SetDataChunk = function (data: string) {
    sessionStorage.setItem('scorm-datachunk', data);
    return true;
  };
  window.getCourseTitle = function () {
    return document.title;
  };
}
