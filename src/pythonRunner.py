"""Run notebook cells 0..N in ONE python process with a shared namespace.

Usage: python3 pythonRunner.py <cells.json> <results.json>
  cells.json:   [{"source": "..."}, ...]   (read from argv[1])
  results.json: {"results": [...]}         (written to argv[2])

One result per input cell, in order:
  {"stdout", "stderr", "exitCode", "images": [{"data", "mime"}], "skipped"}

Per-cell semantics (Jupyter-like):
- stdout/stderr are captured per cell via redirected buffers.
- A cell that raises stops the run: later cells are marked skipped.
- Last-expression display (Jupyter-like): when a cell's last statement
  is a bare expression, its value is captured. A value with a PNG
  representation (`_repr_png_`, or a graphviz-style `.pipe(format='png')`)
  is attached as an image; any other non-None value has its repr
  appended to the cell's stdout (capped). A trailing `;` on the last
  line suppresses the display, as in Jupyter. Display never fails a
  cell: a display error falls back to the text repr.
- matplotlib: plt.show() is patched (lazily, once pyplot is imported) to
  save every open figure as _nm_show_<cell>_<seq>.png and close it.
  After each cell, any still-open figures are harvested as
  _nm_harvest_<cell>_<seq>.png — unless the cell already wrote a PNG
  itself (an explicit savefig wins; harvesting would duplicate it).
- New *.png files created during a cell are attributed to that cell,
  deduplicated by content hash (a show() of an already-savefig'd figure
  yields identical bytes).
- The runner prints nothing; all output goes to results.json.
"""

import ast
import base64
import hashlib
import io
import json
import os
import sys
import traceback

MAX_IMAGES_PER_CELL = 20
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_REPR_CHARS = 10_000


def display_png(value):
    """PNG bytes for a displayable value, or None.

    Prefers `_repr_png_`; otherwise a graphviz-style `.pipe(format='png')`
    (a Digraph has no `_repr_png_`, only `_repr_svg_`, and its `pipe`
    renders PNG via the `dot` binary). SVG/JPEG-only values return None —
    the run-all frontend labels every image `image/png`, so only PNG is
    produced here; those values fall back to their text repr. Never
    raises: a display failure is the caller's problem to swallow.
    """
    try:
        png = getattr(value, '_repr_png_', None)
        if callable(png):
            data = png()
            if isinstance(data, tuple):
                data = data[0]
            if isinstance(data, (bytes, bytearray)) and bytes(data).startswith(b'\x89PNG'):
                return bytes(data)
    except Exception:
        pass
    try:
        pipe = getattr(value, 'pipe', None)
        if callable(pipe):
            data = pipe(format='png')
            if isinstance(data, (bytes, bytearray)) and bytes(data).startswith(b'\x89PNG'):
                return bytes(data)
    except Exception:
        pass
    return None


def exec_cell(src, cell_label, ns):
    """Execute one cell like Jupyter: run its statements, and when the
    last statement is a bare expression, evaluate it and return its
    value (None when there is no trailing expression, or when the last
    line ends with `;`, which suppresses display). Falls back to a
    plain exec when the source does not parse, so a SyntaxError
    surfaces exactly as before. An error in the expression itself
    propagates, like any other cell error."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        exec(compile(src, cell_label, 'exec'), ns)
        return None
    body = tree.body
    if not body or not isinstance(body[-1], ast.Expr):
        exec(compile(src, cell_label, 'exec'), ns)
        return None
    last = body[-1]
    head = body[:-1]
    if head:
        module = ast.Module(body=head, type_ignores=[])
        ast.fix_missing_locations(module)
        exec(compile(module, cell_label, 'exec'), ns)
    expr = ast.Expression(last.value)
    ast.fix_missing_locations(expr)
    value = eval(compile(expr, cell_label, 'eval'), ns)
    stripped = [ln for ln in src.splitlines() if ln.strip()]
    if stripped and stripped[-1].rstrip().endswith(';'):
        return None
    return value


def png_files(workdir):
    return {n for n in os.listdir(workdir) if n.lower().endswith('.png')}


def main():
    cells_path, results_path = sys.argv[1], sys.argv[2]
    with open(cells_path, 'r', encoding='utf-8') as f:
        cells = json.load(f)
    workdir = os.getcwd()
    # User code sees the temp dir first (imports, relative file writes).
    if workdir not in sys.path:
        sys.path.insert(0, workdir)

    ns = {'__name__': '__main__'}
    results = []
    show_state = {'cell': 0, 'seq': 0}

    def patch_show():
        # Patch plt.show once pyplot is imported. The patch saves all open
        # figures (attributed to the current cell) and closes them, so a
        # lab's plt.show() produces an image instead of a no-op (Agg).
        # Never let the hook break user code.
        try:
            import matplotlib.pyplot as plt
        except Exception:
            return
        if getattr(plt.show, '_nm_patched', False):
            return

        def _show(*args, **kwargs):
            try:
                for n in plt.get_fignums():
                    show_state['seq'] += 1
                    plt.figure(n).savefig(os.path.join(
                        workdir,
                        f"_nm_show_{show_state['cell']}_{show_state['seq']}.png"))
                plt.close('all')
            except Exception:
                pass

        _show._nm_patched = True
        plt.show = _show

    def harvest(cell_idx):
        # Save still-open figures (e.g. a cell that imported pyplot and
        # called plt.show() in the same cell, before the patch could
        # apply, or that plotted without showing at all).
        try:
            import matplotlib.pyplot as plt
        except Exception:
            return
        try:
            figs = plt.get_fignums()
        except Exception:
            return
        seq = 0
        for n in figs:
            seq += 1
            try:
                plt.figure(n).savefig(os.path.join(
                    workdir, f"_nm_harvest_{cell_idx}_{seq}.png"))
            except Exception:
                pass
        try:
            plt.close('all')
        except Exception:
            pass

    stopped = False
    for i, cell in enumerate(cells):
        if stopped:
            results.append({'stdout': '', 'stderr': '', 'exitCode': None,
                            'images': [], 'skipped': True})
            continue
        src = cell.get('source', '') if isinstance(cell, dict) else str(cell)
        before = png_files(workdir)
        show_state['cell'] = i
        show_state['seq'] = 0
        patch_show()

        out_buf = io.StringIO()
        err_buf = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out_buf, err_buf
        exit_code = 0
        display_value = None
        try:
            display_value = exec_cell(src, f'<cell {i}>', ns)
        except SystemExit as e:
            exit_code = e.code if isinstance(e.code, int) else 1
            stopped = True
        except BaseException:
            exit_code = 1
            err_buf.write(traceback.format_exc())
            stopped = True
        finally:
            sys.stdout, sys.stderr = old_out, old_err

        # Last-expression display, only for a cell that ran cleanly.
        # A display failure never fails the cell: it falls back to the
        # text repr, and a repr failure is swallowed too.
        display_png_bytes = None
        if exit_code == 0 and display_value is not None:
            try:
                display_png_bytes = display_png(display_value)
            except Exception:
                display_png_bytes = None
            if display_png_bytes is None:
                try:
                    text = repr(display_value)
                except Exception:
                    text = ''
                if text:
                    if len(text) > MAX_REPR_CHARS:
                        text = text[:MAX_REPR_CHARS] + '\n… (truncated)'
                    out_buf.write(text + '\n')

        after = png_files(workdir)
        if not (after - before):
            harvest(i)
            after = png_files(workdir)

        # Attribute new PNGs to this cell, deduped by content hash.
        # User-named files sort first so an explicit savefig wins the
        # dedupe over a show()/harvest capture of the same figure.
        images = []
        seen = set()
        new_files = sorted(after - before,
                           key=lambda n: (n.startswith('_nm_'), n))
        for name in new_files[:MAX_IMAGES_PER_CELL]:
            try:
                with open(os.path.join(workdir, name), 'rb') as f:
                    data = f.read()
            except OSError:
                continue
            if len(data) > MAX_IMAGE_BYTES:
                continue
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            images.append({'data': base64.b64encode(data).decode('ascii'),
                           'mime': 'image/png'})
        # The last-expression display image joins the same list, under
        # the same dedupe and cap (a show()/harvest capture of the same
        # figure wins, since it sorts first above).
        if (display_png_bytes is not None
                and len(display_png_bytes) <= MAX_IMAGE_BYTES
                and len(images) < MAX_IMAGES_PER_CELL):
            digest = hashlib.sha256(display_png_bytes).hexdigest()
            if digest not in seen:
                seen.add(digest)
                images.append({'data': base64.b64encode(display_png_bytes).decode('ascii'),
                               'mime': 'image/png'})
        results.append({'stdout': out_buf.getvalue(),
                        'stderr': err_buf.getvalue(),
                        'exitCode': exit_code,
                        'images': images, 'skipped': False})

    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump({'results': results}, f)


if __name__ == '__main__':
    main()
