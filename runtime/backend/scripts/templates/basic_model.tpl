---
model_file: backend/app/models/{{ snake }}.py
---
# --- {{model_file}} ---
# generated for BAT<{{ ticket_id }}>: {{ desc }}
from sqlalchemy import Column, Integer
from app.db.session import Base


class Bat{{ ticket_id }}Model(Base):
    __tablename__ = "bat_{{ ticket_id }}_models"

    id = Column(Integer, primary_key=True)
