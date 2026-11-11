"""Run notebook cells 0..N in ONE python process with a shared namespace.

Usage: python3 pythonRunner.py <cells.json> <results.json>
  cells.json:   [{"source": "..."}, ...]   (read from argv[1])
  results.json: {"results": [...]}         (written to argv[2])

One result per input cell, in order:
  {"stdout", "stderr", "exitCode", "images": [{"data", "mime"}], "skipped"}

Per-cell semantics (Jupyter-like):
- stdout/stderr are captured per cell via redirected buffers.
- A cell that raises stops the run: later cells are marked skipped.
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

import base64
import hashlib
import io
import json
import os
import sys
import traceback

MAX_IMAGES_PER_CELL = 20
MAX_IMAGE_BYTES = 10 * 1024 * 1024


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
        try:
            exec(compile(src, f'<cell {i}>', 'exec'), ns)
        except SystemExit as e:
            exit_code = e.code if isinstance(e.code, int) else 1
            stopped = True
        except BaseException:
            exit_code = 1
            err_buf.write(traceback.format_exc())
            stopped = True
        finally:
            sys.stdout, sys.stderr = old_out, old_err

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
        results.append({'stdout': out_buf.getvalue(),
                        'stderr': err_buf.getvalue(),
                        'exitCode': exit_code,
                        'images': images, 'skipped': False})

    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump({'results': results}, f)


if __name__ == '__main__':
    main()
