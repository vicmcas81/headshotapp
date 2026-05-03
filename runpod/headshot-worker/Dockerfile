FROM runpod/pytorch:2.2.2-py3.10-cuda12.1.1-devel

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY handler.py /app/handler.py

ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "/app/handler.py"]
