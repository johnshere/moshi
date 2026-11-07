"""让 `sidecar/` 进入 `sys.path`，测试可直接 `import moshi_sidecar.*`。

pytest 在 prepend 导入模式下会把 conftest 所在目录加入 `sys.path`；
没有这个文件，`python -m pytest sidecar/tests/...` 只能导入测试目录。
"""
