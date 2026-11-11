# Browser image: the review list only renders after the site's own JavaScript runs.
FROM apify/actor-python-playwright:3.14

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && scrapling install

COPY . ./
RUN python -m compileall -q src/

CMD ["python", "-m", "src"]
