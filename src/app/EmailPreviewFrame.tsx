export function EmailPreviewFrame({html}: {html: string}) {
  // No scripts, forms, same-origin access, navigation of the parent, or remote assets.
  const document = html.replace(
    '<head>',
    "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'\">",
  );
  return (
    <iframe
      className="emailPreviewFrame"
      title="Rendered email preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={document}
    />
  );
}
